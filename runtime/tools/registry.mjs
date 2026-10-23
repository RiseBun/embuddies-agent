export class EmbuddiesToolRegistry {
  #tools = new Map();

  register(tool, handler) {
    if (!tool?.name || typeof handler !== "function")
      throw new Error("工具注册需要名称和执行函数");
    this.#tools.set(tool.name, { ...tool, handler });
  }

  definitions() {
    return [...this.#tools.values()].map(
      ({ handler: _handler, ...tool }) => tool,
    );
  }

  async execute(name, args, context) {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`未知工具：${name}`);
    return tool.handler(args, context);
  }

  names() {
    return [...this.#tools.keys()];
  }
}
