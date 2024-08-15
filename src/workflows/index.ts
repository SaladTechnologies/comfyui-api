import fluxTxt2img from "../workflows/flux/txt2img";

export const workflows = {
  flux: {
    txt2img: fluxTxt2img,
  },
} as const;
