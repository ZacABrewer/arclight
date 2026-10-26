// Vite/Vitest `?raw` imports load fixture files as strings without needing Node typings.
declare module '*?raw' {
  const content: string;
  export default content;
}
