#!/usr/bin/env node

const fs = require('fs').promises;

const usage = `
Usage: node submit-many-jobs.js <accessDomainName> <numJobs>

This script submits multiple jobs to a specified access domain for image generation.
Example: node submit-many-jobs.js http://localhost:3000 10
`;

const accessDomainName = process.argv[2];
const numJobs = parseInt(process.argv[3]) || 10;
if (!accessDomainName || isNaN(numJobs) || numJobs <= 0) {
  console.error(usage);
  process.exit(1);
}

const jobFile = "workflows/sd1.5-txt2img.json";

async function loadJobJson() {
  try {
    const jobData = await fs.readFile(jobFile, 'utf8');
    return JSON.parse(jobData);
  } catch (error) {
    console.error(`Error reading job file: ${error.message}`);
    process.exit(1);
  }
}

function getRandomSeed() {
  return Math.floor(Math.random() * (9999 - 1000 + 1)) + 1000;
}

async function doAJob(jobJson) {
  // Clone the job JSON to avoid modifying the original
  const job = JSON.parse(JSON.stringify(jobJson));
  
  // Generate random seed
  const randomSeed = getRandomSeed();
  
  // Update job["3"]["inputs"]["seed"] to random_seed
  job["3"].inputs.seed = randomSeed;
  
  // Wrap job_json in a "prompt" object
  const payload = { prompt: job };
  
  console.log("Submitting job...");
  
  try {
    const response = await fetch(`${accessDomainName}/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const responseData = await response.json();
    
    // Decode base64 image and save
    const base64Image = responseData.images[0];
    const imageBuffer = Buffer.from(base64Image, 'base64');
    
    // Create output directory if it doesn't exist
    await fs.mkdir('output', { recursive: true });

    const filename = `output/${responseData.filenames[0]}`;
    
    await fs.writeFile(filename, imageBuffer);
    
    console.log("Job Done. Image saved.");
    
  } catch (error) {
    console.error("Error submitting job:", error.message);
    process.exit(1);
  }
}

async function main() {
  const jobJson = await loadJobJson();
  
  // Create array of promises for all jobs
  const jobPromises = [];
  
  for (let i = 0; i < numJobs; i++) {
    console.log(`Submitting job ${i + 1} of ${numJobs}`);
    jobPromises.push(doAJob(jobJson));
  }
  
  // Wait for all jobs to complete
  try {
    await Promise.all(jobPromises);
    console.log("All jobs done.");
  } catch (error) {
    console.error("Error in job execution:", error.message);
    process.exit(1);
  }
}

// Run the main function
main().catch(error => {
  console.error("Unhandled error:", error.message);
  process.exit(1);
});