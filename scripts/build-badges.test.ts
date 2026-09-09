import { describe, expect, it } from "bun:test";
import { parseSvg } from "./build-badges";

describe("build-badges parseSvg", () => {
  it("extracts width, height, and inner content from SVG", () => {
    const raw = `<svg width="105.5" height="28" viewBox="0 0 105.5 28" xmlns="http://www.w3.org/2000/svg"><g id="badge"><rect width="105.5" height="28"/></g></svg>`;
    const [w, h, inner] = parseSvg(raw);
    expect(w).toBe(105.5);
    expect(h).toBe(28);
    expect(inner).toBe('<g id="badge"><rect width="105.5" height="28"/></g>');
  });

  it("throws on missing width/height", () => {
    const raw = `<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>`;
    expect(() => parseSvg(raw)).toThrow("missing width/height");
  });

  it("throws on invalid svg format", () => {
    expect(() => parseSvg("not an svg")).toThrow("invalid svg");
  });
});
