// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";

type TabfilterOption = "pinned" | "dirty";
const defaultBlockMoveFilters: TabfilterOption[] = ["pinned"];

export class TabStacker {
  private static instance: TabStacker;
  private _moveDirection?: "left" | "right" = "left";
  public isProd = true;
  public isBllockingPredicate: (tab: vscode.Tab) => boolean;

  public filterMap = {
    pinned: (t: vscode.Tab) => t.isPinned,
    dirty: (t: vscode.Tab) => t.isDirty,
  };

  private constructor(
    public context: vscode.ExtensionContext,
    public options: {
      blockMoveFilters: TabfilterOption[];
      direction?: "left" | "right" | "auto";
    } = {
      blockMoveFilters: defaultBlockMoveFilters,
    }
  ) {
    this.isProd = context.extensionMode === vscode.ExtensionMode.Production;

    this.isBllockingPredicate = (tab: vscode.Tab): boolean => {
    for (const filter of this.blockMoveFiltersOption) {
      if (this.filterMap[filter] && this.filterMap[filter](tab)) {
        return true;
      }
    }
    return false;
  }
  }

  get moveDirectionOption(): "left" | "right" {
    if (!this._moveDirection) {
      if (!this.options.direction || this.options.direction === "auto") {
        this._moveDirection = "left";
      } else {
        this._moveDirection = ["left", "right"].includes(this.options.direction)
          ? this.options.direction
          : "left";
      }
    }
    return this._moveDirection;
  }

  get blockMoveFiltersOption(): TabfilterOption[] {
    return this.options.blockMoveFilters.some((filter) =>
      defaultBlockMoveFilters.includes(filter)
    )
      ? this.options.blockMoveFilters
      : defaultBlockMoveFilters;
  }

  public static getInstance(context: vscode.ExtensionContext): TabStacker {
    if (!TabStacker.instance) {
      TabStacker.instance = new TabStacker(context);
    }
    return TabStacker.instance;
  }

  public getTabs(): readonly vscode.Tab[] | undefined {
    const tabGroups = vscode.window.tabGroups;
    if (tabGroups) {
      const activeGroup = tabGroups.activeTabGroup;
      return activeGroup.tabs;
    }
    return undefined;
  }

  public blockingTabIndexes(
    tabs: readonly vscode.Tab[],
    predicate: (tab: vscode.Tab) => boolean
  ): readonly number[] {
    if (tabs) {
      return tabs.filter(predicate).map((tab) => tabs.indexOf(tab));
    }
    return [];
  }

  public getStackPosition(
    currentTabIndex: number,
    tabs: readonly vscode.Tab[]
  ): number | undefined {
    let moveByPosition = -1;

    // test if clicked tab is allowed to be stacked
    if (
      !tabs[currentTabIndex] ||
      this.isBllockingPredicate(tabs[currentTabIndex])
    ) {
      if (!this.isProd) {
        console.log(
          `Current tab index ${currentTabIndex} is blocked from stacking with filters (or not in given array):`,
          this.blockMoveFiltersOption
        );
      }
      return undefined;
    }

    if (tabs) {
      const filteredIndexes = this.blockingTabIndexes(
        tabs,
        this.isBllockingPredicate
      );
      //
      switch (this.moveDirectionOption) {
        case "left": {
          // go left from current index until first blocking tab
          const blockingIndex = filteredIndexes.find(
            (index) => index < currentTabIndex
          );
          if (blockingIndex !== undefined) {
            moveByPosition = currentTabIndex - blockingIndex;
          }
          break;
        }
        case "right": {
          // go right from current index until first blocking tab
          const blockingIndex = filteredIndexes.find(
            (index) => index > currentTabIndex
          );
          if (blockingIndex !== undefined) {
            moveByPosition = blockingIndex - currentTabIndex;
          }
          break;
        }
      }
    }

    if (moveByPosition < 0) {
      if (!this.isProd) {
        console.log(
          `No valid stack position ${moveByPosition} found for tab index ${currentTabIndex} in direction ${this.moveDirectionOption} with filters`,
          this.blockMoveFiltersOption
        );
      }
      return undefined;
    }
    return moveByPosition;
  }

  public stackTab() {
    const tabs = this.getTabs();
    if (!tabs) {
      if (!this.isProd) {
        console.log(`No tabs returned from current editor group.`);
      }
      return;
    }

    const currentTabIndex = tabs?.findIndex((t) => t.isActive);
    if (currentTabIndex === -1) {
      if (!this.isProd) {
        console.log(`No active tab found.`);
      }
      return;
    }

    const args = {
      to: this.moveDirectionOption,
      by: "tab",
      value: this.getStackPosition(currentTabIndex, tabs),
    };

    if (args.value === undefined) {
      if (!this.isProd) {
        console.log(
          `Tab index ${currentTabIndex} not moved - no valid stack position found.`
        );
      }
      return;
    }

    if (!this.isProd) {
      console.log("moveActiveEditor args:", args);
    }

    vscode.commands.executeCommand("moveActiveEditor", args);
  }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  // console.log('Congratulations, your extension "helloworld-sample" is now active!');
  const isProd = context.extensionMode === vscode.ExtensionMode.Production;

  if (!isProd) {
    console.log(`Extension "stack-tabs" is now active!`, {
      Development: context.extensionMode === vscode.ExtensionMode.Development,
      Test: context.extensionMode === vscode.ExtensionMode.Test,
    });
  }

  const tabStacker = TabStacker.getInstance(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("stackTabs.stackTab", () => {
      try {
        tabStacker.stackTab();
      } catch (error) {
        console.error("Error stacking tab:", error);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      try {
        tabStacker.stackTab();
      } catch (error) {
        console.error("Error stacking tab:", error);
      }
    })
  );
}
