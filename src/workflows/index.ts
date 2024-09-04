import config from "../config";
// import fluxTxt2img from "../workflows/flux/txt2img";
// import fluxImg2img from "../workflows/flux/img2img";
// import sd15Txt2img from "../workflows/sd1.5/txt2img";
// import sd15Img2img from "../workflows/sd1.5/img2img";
// import sdxlTxt2img from "../workflows/sdxl/txt2img";
// import sdxlImg2img from "../workflows/sdxl/img2img";
// import sdxlTxt2imgWithRefiner from "../workflows/sdxl/txt2img-with-refiner";
import { WorkflowTree, isWorkflow } from "../types";
import fs from "fs";
import ts from "typescript";

const workflows: WorkflowTree = {};

const walk = (dir: string, tree: WorkflowTree) => {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    let filePath = `${dir}/${file}`;
    if (fs.statSync(filePath).isDirectory()) {
      tree[file] = {};
      walk(filePath, tree[file] as WorkflowTree);
    } else {
      // This is happening at runtime, so if it's .ts we need to compile it
      const newPath = filePath.replace(".ts", ".js");
      if (file.endsWith(".ts")) {
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
      console.log(`Evaluating ${newPath}`);
      const workflow = eval(fs.readFileSync(newPath, "utf8"));
      if (workflow && isWorkflow(workflow)) {
        tree[file.replace(".js", "").replace(".ts", "")] = workflow;
      }
    }
  });
};
walk(config.workflowDir, workflows);

// if (config.workflowModels !== "all" && config.workflowModels !== "") {
//   const requestedModels = new Set(config.workflowModels.split(","));
//   Object.keys(workflows).forEach((baseModel) => {
//     if (!requestedModels.has(baseModel)) {
//       delete workflows[baseModel];
//     }
//   });
// }

export default workflows;
