import config from "../config";
import { WorkflowTree, isWorkflow } from "../types";
import fs from "fs";
import ts from "typescript";
import pino from "pino";

const log = pino({ level: config.logLevel });

const workflows: WorkflowTree = {};

const walk = (dir: string, tree: WorkflowTree) => {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    let filePath = `${dir}/${file}`;
    if (fs.statSync(filePath).isDirectory()) {
      log.debug({ directory: filePath }, "Scanning workflow directory");
      tree[file] = {};
      walk(filePath, tree[file] as WorkflowTree);
    } else {
      // This is happening at runtime, so if it's .ts we need to compile it
      const newPath = filePath.replace(".ts", ".js");
      if (file.endsWith(".ts")) {
        log.debug({ file: filePath }, "Transpiling TypeScript workflow");
        const source = fs.readFileSync(filePath, "utf8");
        const result = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS },
        });
        // write it a sibling .js file
        fs.writeFileSync(newPath, result.outputText);
      } else if (file.endsWith(".js")) {
        // fs.cpSync(filePath, newPath);
      } else {
        return;
      }

      // Eval the file in the current context
      log.debug({ file: newPath }, "Evaluating workflow file");
      try {
        const workflow = eval(fs.readFileSync(newPath, "utf8"));
        if (workflow && isWorkflow(workflow)) {
          const workflowName = file.replace(".js", "").replace(".ts", "");
          tree[workflowName] = workflow;
          log.info({ workflow: workflowName, file: newPath }, "Loaded workflow");
        } else {
          log.warn(
            { file: newPath },
            "File does not export a valid Workflow object"
          );
        }
      } catch (e: any) {
        log.error(
          { file: newPath, error: e.message, stack: e.stack },
          "Failed to evaluate workflow file"
        );
      }
    }
  });
};
walk(config.workflowDir, workflows);

export default workflows;
