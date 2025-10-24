// The module 'vscode' contains the VS Code extensibility API
import * as micromatch from 'micromatch';
import * as path from 'path';
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

type TabfilterOption =
  | "pinned"
  | "dirty"
  | "preview"
  | "untitled"
  | "text"
  | "diff"
  | "notebook"
  | "notebook_diff"
  | "webview"
  | "terminal"
  | string;
const defaultBlockMoveFilters: TabfilterOption[] = ["pinned"];

let extensionId = "stack-tabs";
let configId = "stack-tabs";

function throttle<F extends (...args: unknown[]) => unknown>(
  func: F,
  ms: number
): (...args: Parameters<F>) => void {
  let inThrottle: boolean;
  return function (this: unknown, ...args: Parameters<F>) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), ms);
    }
  };
}

export function getCfgValue<R = unknown>(
  key: string,
  type?: "string" | "number" | "boolean" | "Date",
  config?: { get(section: string): unknown | undefined }
):
  | undefined
  | (R extends unknown
      ? typeof type extends "string"
        ? string
        : typeof type extends "number"
        ? number
        : typeof type extends "boolean"
        ? boolean
        : typeof type extends "Date"
        ? Date
        : R
      : R) {
  const cfg = config ?? vscode.workspace.getConfiguration(configId);

  const cfgValue = cfg.get<unknown>(key);
  let value: unknown = cfgValue;

  if (value !== undefined) {
    if (type === "Date") {
      value = new Date(value as string);
    }

    if (type === "number") {
      value = Number(value as string);
    }

    if (type === "boolean") {
      value = Boolean(value as string);
    }
    // @ts-expect-error ignored
    return value;
  }

  return undefined;
}

function isMatch(...args: Parameters<typeof micromatch.isMatch>) {
  return micromatch.isMatch(args[0], args[1], {
    windows: process.platform === "win32",
    ...args[2],
  });
}

const documentCache = new Map<
  string,
  WeakRef<vscode.TextDocument | vscode.NotebookDocument>
>();

function getDocument(uri: vscode.Uri) {
  const cached = documentCache.get(uri.path)?.deref();
  if (cached) {
    return cached;
  }
  let d: vscode.TextDocument | vscode.NotebookDocument | undefined =
    vscode.window.activeTextEditor?.document.uri.path === uri.path
      ? vscode.window.activeTextEditor.document
      : undefined;
  if (!d) {
    d =
      vscode.window.activeNotebookEditor?.notebook.uri.path === uri.path
        ? vscode.window.activeNotebookEditor.notebook
        : undefined;
  }
  if (!d) {
    d = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.path === uri.path
    )?.document;
  }
  if (!d) {
    d = vscode.workspace.textDocuments.find((doc) => doc.uri.path === uri.path);
  }

  if (d) {
    documentCache.set(uri.path, new WeakRef(d));
  }
  return d;
}

function getTabUri(tab: vscode.Tab): vscode.Uri | undefined {
  if (
    tab.input instanceof vscode.TabInputText ||
    tab.input instanceof vscode.TabInputNotebook ||
    tab.input instanceof vscode.TabInputCustom
  ) {
    return tab.input.uri;
  }
  return undefined;
}

export class TabStacker {
  private static instance: TabStacker;
  private _moveDirection?: "left" | "right" = "left";
  public isDebug = true;
  public isBlockingPredicate: (
    tab: vscode.Tab,
    options: typeof this.defaultOptions
  ) => boolean;

  public filterMap = {
    pinned: (t: vscode.Tab) => t.isPinned,
    dirty: (t: vscode.Tab) => t.isDirty,
    preview: (t: vscode.Tab) => t.isPreview,
    text: (t: vscode.Tab) => t.input instanceof vscode.TabInputText,
    diff: (t: vscode.Tab) => t.input instanceof vscode.TabInputTextDiff,
    notebook: (t: vscode.Tab) => t.input instanceof vscode.TabInputNotebook,
    notebook_diff: (t: vscode.Tab) =>
      t.input instanceof vscode.TabInputNotebookDiff,
    webview: (t: vscode.Tab) => t.input instanceof vscode.TabInputWebview,
    terminal: (t: vscode.Tab) => t.input instanceof vscode.TabInputTerminal,
    untitled: (t: vscode.Tab) =>
      (t.input instanceof vscode.TabInputText ||
        t.input instanceof vscode.TabInputNotebook) &&
      getDocument(t.input.uri)?.isUntitled,
  };

  public filterMapCustom = [
    {
      match: (t: vscode.Tab, filter: string) =>
        filter.startsWith("title:") &&
        isMatch(t.label, filter.replace("title:", "").trim()),
      prefix: "title:",
    },
    {
      match: (t: vscode.Tab, filter: string) =>
        filter.startsWith("path:") &&
        isMatch(getTabUri(t)?.fsPath ?? "", filter.replace("path:", "").trim()),
      prefix: "path:",
    },
    {
      match: (t: vscode.Tab, filter: string) =>
        t.input instanceof vscode.TabInputText &&
        filter.startsWith("lang:") &&
        isMatch(
          (getDocument(t.input.uri) as vscode.TextDocument | undefined)
            ?.languageId ?? "",
          filter.replace("lang:", "").trim()
        ),
      prefix: "lang:",
    },
  ];

  private constructor(
    public context: vscode.ExtensionContext,
    public defaultOptions: {
      blockMoveFilters: TabfilterOption[];
      direction?: "left" | "right" | "auto";
      padding?: number;
      enabled?: boolean;
    } = {
      blockMoveFilters: defaultBlockMoveFilters,
      enabled: true,
    }
  ) {
    this.isDebug = context.extensionMode !== vscode.ExtensionMode.Production;

    const resolvedFilters = {} as Record<string, string>;

    const findCustomMap = (filter: string) =>
      this.filterMapCustom.find((f) => filter.startsWith(f.prefix));
    this.isBlockingPredicate = (
      tab: vscode.Tab,
      options: typeof this.defaultOptions
    ): boolean => {
      const prefixes = this.filterMapCustom.map((f) => f.prefix);

      const hasPrefix = (f: string) => prefixes.some((p) => f.startsWith(p));

      const filters = options.blockMoveFilters;

      for (const f of filters) {
        if (hasPrefix(f)) {
          let rFilter = f;
          if (["path:"].some((p) => f.startsWith(p))) {
            if (resolvedFilters[f] === undefined) {
              resolvedFilters[f] = resolveVariables(f);
            }
            rFilter = resolvedFilters[f];
          }

          const customFilter = findCustomMap(rFilter);
          if (customFilter && customFilter.match(tab, rFilter)) {
            return true;
          }
        }

        const m = this.filterMap[f as keyof typeof this.filterMap];
        if (m && m(tab)) {
          return true;
        }
      }

      return false;
    };
  }

  public getOptions(scope?: vscode.ConfigurationScope | null) {
    if (scope !== undefined) {
      const cfg = vscode.workspace.getConfiguration(
        configId,
        scope === null ? undefined : scope
      );
      return {
        blockMoveFilters:
          getCfgValue<TabfilterOption[]>("blockMoveFilters", undefined, cfg) ??
          [],
        direction: getCfgValue<"left" | "right" | "auto">(
          "direction",
          "string",
          cfg
        ),
        padding: getCfgValue<number>("padding", "number", cfg),
        enabled: getCfgValue<boolean>("enabled", "boolean", cfg),
      };
    }
    return this.defaultOptions;
  }

  public loadOptions(scope?: vscode.ConfigurationScope) {
    this.defaultOptions = this.getOptions(scope ?? null);
  }

  public getMoveDirectionOption(
    scope?: vscode.ConfigurationScope | null
  ): "left" | "right" {
    const options = this.getOptions(scope);
    if (!options.direction || options.direction === "auto") {
      return "left";
    } else {
      return ["left", "right"].includes(options.direction)
        ? options.direction
        : "left";
    }
  }

  public getEnabledOption(scope?: vscode.ConfigurationScope | null): boolean {
    const options = this.getOptions(scope);
    return options.enabled ?? true;
  }

  public getPaddingOption(scope?: vscode.ConfigurationScope | null): number {
    const options = this.getOptions(scope);
    return options.padding ?? 0;
  }

  public getBlockMoveFiltersOption(
    scope?: vscode.ConfigurationScope | null
  ): TabfilterOption[] {
    const options = this.getOptions(scope);
    return options.blockMoveFilters.some((filter) =>
      defaultBlockMoveFilters.includes(filter)
    )
      ? options.blockMoveFilters
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
    isBlockingPredicate: (
      tab: vscode.Tab,
      options: typeof this.defaultOptions
    ) => boolean,
    options: typeof this.defaultOptions
  ): readonly number[] {
    if (tabs) {
      return tabs
        .filter((tab) => isBlockingPredicate(tab, options))
        .map((tab) => tabs.indexOf(tab));
    }
    return [];
  }

  public getStackPosition(
    currentTabIndex: number,
    tabs: readonly vscode.Tab[],
    isBlockingPredicate: (
      tab: vscode.Tab,
      options: typeof this.defaultOptions
    ) => boolean,
    options: typeof this.defaultOptions
  ): number | undefined {
    let moveDelta = -1;
    const { direction, padding } = options;

    // test if clicked tab is allowed to be stacked
    if (
      !tabs[currentTabIndex] ||
      isBlockingPredicate(tabs[currentTabIndex], options)
    ) {
      if (this.isDebug) {
        console.log(
          `Current tab index ${currentTabIndex} is blocked from stacking with filters (or not in given array):`,
          this.getBlockMoveFiltersOption()
        );
      }
      return undefined;
    }

    if (tabs) {
      const filteredIndexes = this.blockingTabIndexes(
        tabs,
        isBlockingPredicate,
        options
      );
      switch (direction) {
        case "left": {
          // go left from current index until first blocking tab
          const blockingIndex = filteredIndexes.findLast(
            (index) => index < currentTabIndex
          );
          if (blockingIndex === undefined) {
            moveDelta = Math.abs(0 - currentTabIndex);
          } else {
            moveDelta = currentTabIndex - blockingIndex - 1;
          }

          if (padding) {
            moveDelta = Math.max(0, moveDelta - padding);
          }

          break;
        }
        case "right": {
          // go right from current index until first blocking tab
          const blockingIndex = filteredIndexes.find(
            (index) => index > currentTabIndex
          );
          if (blockingIndex === undefined) {
            moveDelta = tabs.length - currentTabIndex - 1;
          } else {
            moveDelta = blockingIndex - currentTabIndex - 1;
          }

          if (padding) {
            moveDelta = Math.max(0, moveDelta - padding);
          }
          break;
        }
      }
    }

    if (moveDelta < 0) {
      if (this.isDebug) {
        console.log(
          `No valid stack position ${moveDelta} found for tab index ${currentTabIndex} in direction ${this.getMoveDirectionOption} with filters`,
          this.getBlockMoveFiltersOption()
        );
      }
      return undefined;
    }

    return moveDelta;
  }

  public stackTab() {
    const tabs = this.getTabs();
    if (!tabs) {
      if (this.isDebug) {
        console.log(`No tabs returned from current editor group.`);
      }
      return;
    }

    const currentTabIndex = tabs?.findIndex((t) => t.isActive);
    if (currentTabIndex === -1) {
      if (this.isDebug) {
        console.log(`No active tab found.`);
      }
      return;
    }

    const tab = tabs[currentTabIndex]!;
    const uri = getTabUri(tab);

    const options = {
      blockMoveFilters: this.getBlockMoveFiltersOption(uri),
      direction: this.getMoveDirectionOption(uri),
      padding: this.getPaddingOption(uri),
    };

    const args = {
      to: "position",
      by: "tab",
      value: this.getStackPosition(
        currentTabIndex,
        tabs,
        this.isBlockingPredicate,
        options
      ),
    };

    if (args.value === undefined || args.value <= 0) {
      if (this.isDebug) {
        console.log(
          `Tab index ${currentTabIndex} not moved - no valid stack position found.`
        );
      }
      return;
    }

    if (this.isDebug) {
      console.log(
        "moveActiveEditor args:",
        args,
        "on tab",
        tabs[currentTabIndex]
      );
    }

    vscode.commands.executeCommand("moveActiveEditor", args);
  }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  extensionId = context.extension.id;
  configId = extensionId.split(".").pop() || "stack-tabs";
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  // console.log('Congratulations, your extension "helloworld-sample" is now active!');
  const isProd = context.extensionMode === vscode.ExtensionMode.Production;
  const isDebug =
    getCfgValue<boolean>(
      "debug",
      "boolean",
      vscode.workspace.getConfiguration(configId, null)
    ) ?? !isProd;

  if (!isProd) {
    console.log(`Extension "stack-tabs" is now active!`, {
      Development: context.extensionMode === vscode.ExtensionMode.Development,
      Test: context.extensionMode === vscode.ExtensionMode.Test,
    });
  }

  const tabStacker = TabStacker.getInstance(context);
  tabStacker.loadOptions(vscode.workspace.workspaceFolders?.[0]);
  tabStacker.isDebug = isDebug;

  const throttledStackTab = throttle(() => {
    tabStacker.stackTab();
  }, 100);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      try {
        if (e.affectsConfiguration(configId)) {
          if (tabStacker.isDebug) {
            console.log(`Configuration changed, reloading options.`);
          }
          tabStacker.loadOptions(vscode.workspace.workspaceFolders?.[0]);
        }
      } catch (error) {
        console.error("Error reloading configuration:", error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("stackTabs.stackTab", () => {
      if (!context.extension.isActive) {
        return;
      }
      try {
        throttledStackTab();
      } catch (error) {
        console.error("Error stacking tab:", error);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      vscode.commands.executeCommand("stackTabs.stackTab");
    })
  );
}

function getActiveWorkspaceFolder() {
  const u = getActiveFileUri();
  if (!u) {
    return undefined;
  }
  return vscode.workspace.getWorkspaceFolder(u);
}

function getActiveFileUri() {
  const u =
    vscode.window.activeTextEditor?.document.uri ||
    vscode.window.activeNotebookEditor?.notebook.uri;
  return u;
}

const variables = {
  userHome: () => process.env.HOME || process.env.USERPROFILE || "",
  workspaceFolder: (args: { workspaceFolder?: vscode.WorkspaceFolder }) =>
    (args.workspaceFolder ?? getActiveWorkspaceFolder())?.uri.fsPath ?? "",
  workspaceFolderBasename: (args: {
    workspaceFolder?: vscode.WorkspaceFolder;
  }) => variables.workspaceFolder(args).split(path.sep).pop() ?? "",
  file: (args: { document?: vscode.TextDocument }) =>
    (args.document?.uri ?? getActiveFileUri())?.fsPath ?? "",
  fileWorkspaceFolder: (args: { document?: vscode.TextDocument }) =>
    args.document?.uri ?? getActiveFileUri()
      ? vscode.workspace.getWorkspaceFolder(
          args.document?.uri ?? getActiveFileUri()!
        )?.uri.fsPath ?? ""
      : "",
  relativeFile: (args: { document?: vscode.TextDocument }) =>
    path.relative(variables.file(args), variables.fileWorkspaceFolder(args)),
  relativeFileDirname: (args: { document?: vscode.TextDocument }) =>
    path.dirname(variables.relativeFile(args)),
  fileBasename: (args: { document?: vscode.TextDocument }) =>
    path.basename(variables.file(args)),
  fileBasenameNoExtension: (args: { document?: vscode.TextDocument }) =>
    path.parse(variables.file(args)).name,
  fileExtname: (args: { document?: vscode.TextDocument }) =>
    path.extname(variables.file(args)),
  fileDirname: (args: { document?: vscode.TextDocument }) =>
    path.dirname(variables.file(args)),
  fileDirnameBasename: (args: { document?: vscode.TextDocument }) =>
    path.basename(variables.fileDirname(args)),
  cwd: () => process.cwd(),
  pathSeparator: () => path.sep,
  ["/"]: () => path.sep,
};

const variablePattern = Object.fromEntries(
  Object.keys(variables).map((k) => [k, new RegExp(`\\$\\{${k}}`, "g")])
);

function resolveVariables(
  value: string,
  args: {
    document?: vscode.TextDocument;
    workspaceFolder?: vscode.WorkspaceFolder;
  } = {}
): string {
  let resolved = value;
  Object.entries(variables).forEach(([key, fn]) => {
    resolved = resolved.replace(variablePattern[key], fn(args));
  });
  return resolved;
}