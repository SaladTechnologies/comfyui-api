import fluxTxt2img from "../workflows/flux/txt2img";
import fluxImg2img from "../workflows/flux/img2img";
import sd15Txt2img from "../workflows/sd1.5/txt2img";

export const workflows: any = {
  flux: {
    txt2img: fluxTxt2img,
    img2img: fluxImg2img,
  },
  "sd1.5": {
    txt2img: sd15Txt2img,
  },
};
