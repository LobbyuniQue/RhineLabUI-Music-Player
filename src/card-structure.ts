import type { Object3D } from "three";

export const ARRAY_CARD_SURFACES = new Set([
  "Frosted_Polymer",
  "Ivory_Edges",
  "Titanium_Fasteners",
  "Index_Inlay",
  "Optical_Diffuser",
]);

export function setCardInteriorVisible(group: Object3D, visible: boolean) {
  group.traverse(child => {
    const surface = child.userData.surface;
    // Printed labels and the dynamic canvas remain on the lightweight shell.
    if (typeof surface === "string" && surface !== "Printed_Label" && !ARRAY_CARD_SURFACES.has(surface))
      child.visible = visible;
  });
}
