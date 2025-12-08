import { AmqpClient } from './amqp-client';
import config from './config';
import { FastifyBaseLogger } from 'fastify';
import os from 'os';

export class ServiceRegistry {
  private amqpClient: AmqpClient;
  private log: FastifyBaseLogger;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private instanceId: string;
  private currentTaskId: string | null = null;

  constructor(amqpClient: AmqpClient, log: FastifyBaseLogger) {
    this.amqpClient = amqpClient;
    this.log = log;
    this.instanceId = config.instanceId;
  }

  private generateInstanceId(): string {
    return config.instanceId;
  }

  async register(): Promise<void> {
    const vram = (config.instanceGpuVram || '').toLowerCase();
    const type = vram.includes('70') ? 3 : vram.includes('40') || vram.includes('35') ? 2 : 1;
    const monopolizeType = config.instanceDedicatedId ? 1 : 2;
    const registerData = {
      instance_id: this.instanceId,
      server_url: config.comfyPublicURL,
      ws_url: config.comfyPublicWSURL,
      api_url: config.selfURL,
      type,
      monopolize_type: monopolizeType,
      version: config.apiVersion,
      capabilities: {
        max_concurrent_tasks: 1,
        supported_models: config.supportedModels ? config.supportedModels.split(',') : [],
        gpu_memory: config.gpuMemory || config.instanceGpuVram || 'unknown'
      }
    };
    const metadata: Record<string, string> = { ...config.systemMetaData, container_id: os.hostname() };
    await this.amqpClient.publishToExchange('service.instance.register', {
      protocol_version: '1.0',
      event_type: 'instance_register',
      timestamp: Date.now(),
      data: registerData,
      metadata
    });
    this.log.info(`Instance registered: ${this.instanceId}`);
  }

  startHeartbeat(): void {
    const hbEnabledEnv = process.env.HEARTBEAT_ENABLED;
    const heartbeatEnabled = hbEnabledEnv ? hbEnabledEnv.toLowerCase() === 'true' : true;
    if (!heartbeatEnabled) {
      this.log.info('Heartbeat disabled');
      return;
    }
    const interval = process.env.HEARTBEAT_INTERVAL ? parseInt(process.env.HEARTBEAT_INTERVAL, 10) : 5000;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat().catch(() => {}), interval);
    this.log.info(`Heartbeat started (interval=${interval}ms)`);
  }

  private async sendHeartbeat(): Promise<void> {
    const heartbeatData = {
      instance_id: this.instanceId,
      status: this.currentTaskId ? 'BUSY' : 'IDLE',
      current_task_id: this.currentTaskId,
      queue_size: await this.getQueueSize(),
      system_info: {
        cpu_usage: this.getCpuUsage(),
        memory_usage: this.getMemoryUsage(),
        uptime: process.uptime()
      }
    };
    await this.amqpClient.publishToExchange('service.instance.heartbeat', {
      protocol_version: '1.0',
      event_type: 'instance_heartbeat',
      timestamp: Date.now(),
      data: heartbeatData
    });
  }

  async unregister(reason: string = 'SHUTDOWN'): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.amqpClient.publishToExchange('service.instance.unregister', {
      protocol_version: '1.0',
      event_type: 'instance_unregister',
      timestamp: Date.now(),
      data: { instance_id: this.instanceId, api_url: config.selfURL, reason }
    });
    this.log.info(`Instance unregistered: ${this.instanceId} (${reason})`);
  }

  setCurrentTask(taskId: string | null) {
    this.currentTaskId = taskId;
  }

  private async getQueueSize(): Promise<number> {
    try {
      const resp = await fetch(`${config.comfyURL}/queue`);
      const data: any = await resp.json();
      return data.queue_pending?.length || 0;
    } catch {
      return 0;
    }
  }

  private getCpuUsage(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += (cpu.times as any)[type];
      }
      totalIdle += cpu.times.idle;
    });
    return 100 - (100 * totalIdle / totalTick);
  }

  private getMemoryUsage(): number {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return ((totalMem - freeMem) / totalMem) * 100;
  }
}
