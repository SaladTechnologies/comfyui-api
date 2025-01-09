import config from "../config";
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

export default workflows;
