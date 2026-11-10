import { expect } from "vitest";
import { type GantryMatchers, gantryMatchers } from "../src/testing/index.js";

expect.extend(gantryMatchers);

declare module "vitest" {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends GantryMatchers<R> {}
}
