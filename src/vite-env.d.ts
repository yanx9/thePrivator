/// <reference types="vite/client" />

/**
 * CSS Modules are resolved by Vite, so TypeScript needs to be told they exist.
 * The index signature is deliberately loose: generating exact class-name types
 * would need a build step, and a component test may not assert on class names
 * anyway -- they are hashed.
 */
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
