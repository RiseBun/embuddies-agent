import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
afterEach(cleanup);
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { value: Observer });
