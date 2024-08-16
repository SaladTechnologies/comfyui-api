import config from "../config";
import fluxTxt2img from "../workflows/flux/txt2img";
import fluxImg2img from "../workflows/flux/img2img";
import sd15Txt2img from "../workflows/sd1.5/txt2img";
import sdxlImg2img from "../workflows/sdxl/img2img";
import { Workflow } from "../types";

const workflows: {
  [key: string]: {
    [key: string]: Workflow;
  };
} = {
  flux: {
    txt2img: fluxTxt2img,
    img2img: fluxImg2img,
  },
  "sd1.5": {
    txt2img: sd15Txt2img,
  },
  sdxl: {
    img2img: sdxlImg2img,
  },
};

if (config.workflowModels !== "all" && config.workflowModels !== "") {
  const requestedModels = new Set(config.workflowModels.split(","));
  Object.keys(workflows).forEach((baseModel) => {
    if (!requestedModels.has(baseModel)) {
      delete workflows[baseModel];
    }
  });
}

export default workflows;
