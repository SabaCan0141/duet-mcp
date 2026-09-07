// JSON shared by humans and LLMs. In-progress drafts stay in the UI.
export type Box = { x: number; y: number; width: number; height: number };
export type Settings = {
  caption: string;
  notes: string;
  visible: boolean;
  grid: boolean;
  style: "solid" | "outline";
  color: "violet" | "blue" | "coral";
  opacity: number;
};
export type Doc = { text: string; settings: Settings; box: Box };
export const defaultSettings = (): Settings => ({
  caption: "Make room for ideas.", notes: "One idea, shaped together by you and AI.",
  visible: true, grid: true, style: "solid", color: "violet", opacity: 100,
});
export const initialDoc = (): Doc => ({ text: "", settings: defaultSettings(), box: { x: 160, y: 120, width: 360, height: 220 } });
export const CANVAS = { width: 720, height: 480, min: 64 };
