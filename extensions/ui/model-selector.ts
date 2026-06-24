// stolen from https://github.com/badlogic/pi-mono/blob/156a9052bc08a5ed08b7f2b82a27796253c4760d/packages/coding-agent/src/modes/interactive/components/model-selector.ts
import { type Api, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import type { ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  matchesKey,
  Key,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";

/**
 * Internal model item type combining provider, id, and model reference.
 */
interface ModelItem {
  /** The model provider name. */
  provider: string;
  /** The model id. */
  id: string;
  /** The full model reference. */
  model: Model<Api>;
}

/**
 * Props for the ModelSelectorComponent.
 */
export interface ModelSelectorOptions {
  /** The currently active model (highlighted with ✓). */
  currentModel: Model<Api> | undefined;
  /** The model registry to load available models from. */
  modelRegistry: ModelRegistry;
  /** Callback when a model is selected. */
  onSelect: (model: Model<Api>) => void;
  /** Callback when the user cancels. */
  onCancel: () => void;
  /** Pre-filled search string (optional). */
  initialSearchInput?: string;
}

/**
 * A rich model selector component with fuzzy search, keyboard navigation,
 * and model details display. Adapted from the pi-mono interactive mode's
 * ModelSelectorComponent, simplified for use in extension commands.
 *
 * Features:
 * - Fuzzy search filtering
 * - Up/down arrow navigation with wrapping
 * - Enter to select, Escape to cancel
 * - Shows model name for the selected model
 * - Highlights the current/active model with a checkmark
 * - Scroll indicator when list overflows visible area
 */
export class ModelSelectorComponent extends Container implements Focusable {
  /** The search input field for fuzzy filtering. */
  private searchInput: Input;

  // Focusable implementation - propagate to searchInput for IME cursor positioning
  /** Whether the component is focused (propagates to searchInput). */
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  /** Container holding the list of model items. */
  private listContainer: Container;
  /** All available models from the registry. */
  private allModels: ModelItem[] = [];
  /** Models filtered and sorted for display. */
  private activeModels: ModelItem[] = [];
  /** Models filtered by the current search query. */
  private filteredModels: ModelItem[] = [];
  /** Currently selected item index in filteredModels. */
  private selectedIndex: number = 0;
  /** The currently active/selected model (shown with a checkmark). */
  private currentModel: Model<Api> | undefined;
  /** The model registry to load available models from. */
  private modelRegistry: ModelRegistry;
  /** Callback invoked when a model is selected. */
  private onSelectCallback: (model: Model<Api>) => void;
  /** Callback invoked when the user cancels. */
  private onCancelCallback: () => void;
  /** Error message if models failed to load. */
  private errorMessage?: string;
  /** The TUI instance for requesting renders. */
  private tui: TUI;
  /** The theme object for formatting text. */
  private theme: Theme;

  /**
   * Creates a new model selector component.
   * @param tui - The TUI instance.
   * @param theme - The theme object.
   * @param options - Configuration options.
   */
  constructor(tui: TUI, theme: Theme, options: ModelSelectorOptions) {
    super();

    this.tui = tui;
    this.theme = theme;
    this.currentModel = options.currentModel;
    this.modelRegistry = options.modelRegistry;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;

    // Add top border
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    this.addChild(new Spacer(1));

    // Add title
    this.addChild(
      new Text(theme.fg("accent", theme.bold("Select Auto Mode Classifier Model")), 1, 0),
    );
    this.addChild(new Spacer(1));

    // Add hint about filtering
    const hintText = "Only showing models from configured providers. Use /login to add providers.";
    this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
    this.addChild(new Spacer(1));

    // Create search input
    this.searchInput = new Input();
    if (options.initialSearchInput) {
      this.searchInput.setValue(options.initialSearchInput);
    }
    this.searchInput.onSubmit = () => {
      // Enter on search input selects the first filtered item
      const item = this.filteredModels[this.selectedIndex];
      if (item) {
        this.handleSelect(item.model);
      }
    };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    // Create list container
    this.listContainer = new Container();
    this.addChild(this.listContainer);

    this.addChild(new Spacer(1));

    // Add bottom border
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    // Load models and do initial render
    this.loadModels();
    if (options.initialSearchInput) {
      this.filterModels(options.initialSearchInput);
    } else {
      this.updateList();
    }
    // Request re-render after models are loaded
    this.tui.requestRender();
  }

  /**
   * Loads available models from the registry and sorts them.
   */
  private loadModels(): void {
    // Refresh to pick up any changes to models
    this.modelRegistry.refresh();

    // Check for models load errors
    const loadError = this.modelRegistry.getError();
    if (loadError) {
      this.errorMessage = loadError;
    }

    // Load available models
    try {
      const availableModels = this.modelRegistry.getAvailable();
      this.allModels = availableModels.map((model: Model<Api>) => ({
        provider: model.provider,
        id: model.id,
        model,
      }));
    } catch (error) {
      this.allModels = [];
      this.errorMessage = error instanceof Error ? error.message : String(error);
      return;
    }

    this.activeModels = this.sortModels([...this.allModels]);
    this.filteredModels = this.activeModels;
    const currentIndex = this.filteredModels.findIndex((item) =>
      modelsAreEqual(this.currentModel, item.model),
    );
    this.selectedIndex =
      currentIndex >= 0
        ? currentIndex
        : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
  }

  /**
   * Sorts models: current model first, then by provider name.
   * @param models - The models to sort.
   * @returns The sorted models.
   */
  private sortModels(models: ModelItem[]): ModelItem[] {
    const sorted = [...models];
    // Sort: current model first, then by provider
    sorted.sort((a, b) => {
      const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
      const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      return a.provider.localeCompare(b.provider);
    });
    return sorted;
  }

  /**
   * Filters models by fuzzy search query.
   * @param query - The search query.
   */
  private filterModels(query: string): void {
    this.filteredModels = query
      ? fuzzyFilter(
          this.activeModels,
          query,
          ({ id, provider }) => `${id} ${provider} ${provider}/${id} ${provider} ${id}`,
        )
      : this.activeModels;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
    this.updateList();
  }

  /**
   * Re-renders the visible list of models.
   */
  private updateList(): void {
    this.listContainer.clear();

    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        this.filteredModels.length - maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

    // Show visible slice of filtered models
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredModels[i];
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const isCurrent = modelsAreEqual(this.currentModel, item.model);

      let line = "";
      if (isSelected) {
        const prefix = this.theme.fg("accent", "→ ");
        const modelText = `${item.id}`;
        const providerBadge = this.theme.fg("muted", `[${item.provider}]`);
        const checkmark = isCurrent ? this.theme.fg("success", " ✓") : "";
        line = `${prefix + this.theme.fg("accent", modelText)} ${providerBadge}${checkmark}`;
      } else {
        const modelText = `  ${item.id}`;
        const providerBadge = this.theme.fg("muted", `[${item.provider}]`);
        const checkmark = isCurrent ? this.theme.fg("success", " ✓") : "";
        line = `${modelText} ${providerBadge}${checkmark}`;
      }

      this.listContainer.addChild(new Text(truncateToWidth(line, 80), 0, 0));
    }

    // Add scroll indicator if needed
    if (startIndex > 0 || endIndex < this.filteredModels.length) {
      const scrollInfo = this.theme.fg(
        "dim",
        `  (${this.selectedIndex + 1}/${this.filteredModels.length})`,
      );
      this.listContainer.addChild(new Text(scrollInfo, 0, 0));
    }

    // Show error message or "no results" if empty
    if (this.errorMessage) {
      const errorLines = this.errorMessage.split("\n");
      for (const line of errorLines) {
        this.listContainer.addChild(new Text(this.theme.fg("error", line), 0, 0));
      }
    } else if (this.filteredModels.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
    } else {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected) {
        this.listContainer.addChild(new Spacer(1));
        this.listContainer.addChild(
          new Text(this.theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0),
        );
      }
    }
  }

  /**
   * Handles keyboard input for navigation and selection.
   * @param keyData - The key data string.
   */
  handleInput(keyData: string): void {
    const kb = getKeybindings();
    // Up arrow - wrap to bottom when at top
    if (matchesKey(keyData, Key.up) || kb.matches(keyData, "tui.select.up")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
      this.updateList();
      this.tui.requestRender();
    }
    // Down arrow - wrap to top when at bottom
    else if (matchesKey(keyData, Key.down) || kb.matches(keyData, "tui.select.down")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      this.tui.requestRender();
    }
    // Enter
    else if (matchesKey(keyData, Key.enter) || kb.matches(keyData, "tui.select.confirm")) {
      const selectedModel = this.filteredModels[this.selectedIndex];
      if (selectedModel) {
        this.handleSelect(selectedModel.model);
      }
    }
    // Escape or Ctrl+C
    else if (matchesKey(keyData, Key.escape) || matchesKey(keyData, Key.ctrl("c"))) {
      this.onCancelCallback();
    }
    // Pass everything else to search input
    else {
      this.searchInput.handleInput(keyData);
      this.filterModels(this.searchInput.getValue());
      this.tui.requestRender();
    }
  }

  /**
   * Invokes the select callback with the chosen model.
   * @param model - The selected model.
   */
  private handleSelect(model: Model<Api>): void {
    this.onSelectCallback(model);
  }

  /**
   * Returns the search input component.
   * @returns The search input field.
   */
  getSearchInput(): Input {
    return this.searchInput;
  }
}
