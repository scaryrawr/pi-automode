import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type DialogThemeColor = "warning" | "borderMuted" | "muted" | "text" | "dim" | "success" | "error";

type DialogTheme = {
  fg: (color: DialogThemeColor, text: string) => string;
  bg: (color: "selectedBg", text: string) => string;
  bold: (text: string) => string;
};

/**
 * Permission dialog component for manually approving blocked automode fallback tool calls.
 */
export class PermissionDialog {
  container: Container;
  input: Input;
  selectedIndex: number = 0;
  cachedWidth: number | undefined;
  cachedLines: string[] | undefined;
  onDone: ((result: ToolCallEventResult) => void) | undefined;
  #toolName: string;
  #inputDescription: string;
  #theme: DialogTheme;

  constructor(toolName: string, inputDescription: string, theme: DialogTheme) {
    this.#toolName = toolName;
    this.#inputDescription = inputDescription;
    this.#theme = theme;
    this.container = new Container();

    this.container.addChild(new DynamicBorder((s: string) => this.#theme.fg("warning", s)));
    this.container.addChild(
      new Text(this.#theme.fg("warning", this.#theme.bold("Permission Required")), 1, 0),
    );

    const infoBox = new Container();
    infoBox.addChild(new DynamicBorder((s: string) => this.#theme.fg("borderMuted", s)));
    infoBox.addChild(new Text(this.#theme.fg("muted", `Tool: ${this.#toolName}`), 1, 0));
    infoBox.addChild(new DynamicBorder((s: string) => this.#theme.fg("borderMuted", s)));
    this.container.addChild(infoBox);

    this.container.addChild(new Text(this.#theme.fg("text", this.#inputDescription), 1, 0));
    this.container.addChild(new Text("", 0, 1));
    this.container.addChild(
      new Text(this.#theme.fg("dim", "up/down navigate, enter confirm, esc/ctrl+c cancel"), 1, 0),
    );
    this.container.addChild(new Text("", 0, 1));

    this.input = new Input();

    this.container.addChild(new DynamicBorder((s: string) => this.#theme.fg("warning", s)));
  }

  handleInput(data: string, tui: { requestRender: () => void }): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onDone?.({
        block: true,
        reason: "User cancelled the permission request.",
      });
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
      this.selectedIndex = 0;
      this.input.focused = false;
      this.invalidate();
      tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
      this.selectedIndex = 1;
      this.input.focused = true;
      this.invalidate();
      tui.requestRender();
      return;
    }

    if (this.selectedIndex === 1) {
      if (matchesKey(data, Key.enter)) {
        this.onDone?.({
          block: true,
          reason: this.input.getValue() || "Blocked by user.",
        });
        return;
      }

      this.input.handleInput(data);
      this.invalidate();
      tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.onDone?.({ block: false });
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const renderButtonLine = (
      label: string,
      color: "success" | "error",
      selected: boolean,
    ): string => {
      const line = truncateToWidth(`  ${label}  `, width, "", true);
      const coloredLine = this.#theme.fg(color, line);
      return selected ? this.#theme.bg("selectedBg", coloredLine) : coloredLine;
    };

    const approveLine = renderButtonLine("Approve", "success", this.selectedIndex === 0);

    const lines = this.container.render(width);
    const insertIndex = Math.max(0, lines.length - 1);

    const inserted: string[] = [approveLine];
    if (this.selectedIndex === 1) {
      // Keep the "Block" button in place and styled the same as when it is not
      // selected, then append the reason input to its right on the same line.
      // This avoids the jarring shift/color change and reveals the field subtly.
      const buttonText = "  Block  ";
      const areaWidth = Math.max(0, width - buttonText.length);
      const inputLine = this.input.render(areaWidth)[0] ?? "";
      const line = this.#theme.fg("error", buttonText) + inputLine;
      // Cap to width so narrow terminals can't overflow the line buffer.
      const capped = truncateToWidth(line, width, "", true);
      inserted.push(this.#theme.bg("selectedBg", capped));
    } else {
      inserted.push(renderButtonLine("Block", "error", false));
    }

    lines.splice(insertIndex, 0, ...inserted);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
