import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Workbench } from "./Workbench";
import { Pet } from "./Brand";
import { applyPreferences, loadPreferences } from "./preferences";
import "./styles.css";
class Boundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h2>界面需要恢复</h2>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>重新打开</button>
        <button onClick={() => window.EMBUDDIES_DESKTOP?.exportDiagnostics()}>
          导出诊断
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
const pet = window.EMBUDDIES_DESKTOP?.args.includes("--embuddies-kind=pet");
if (pet) {
  document.documentElement.classList.add("pet-window");
  document.body.classList.add("pet-window");
}
if (!pet) loadPreferences().then(applyPreferences).catch(() => {});
createRoot(document.getElementById("root")!).render(
  <Boundary>{pet ? <Pet /> : <Workbench />}</Boundary>,
);
