import {
  App,
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";

import { CodexAppServerClient } from "./CodexAppServerClient";
import { CodexidianView, VIEW_TYPE_CODEXIDIAN } from "./CodexidianView";
import { isLocale, setLocale, t, tf } from "./i18n";
import { VaultMcpService, type VaultMcpWriteApprovalRequest } from "./mcp/VaultMcpService";
import {
  DEFAULT_SETTINGS,
  type ApprovalDecision,
  type ApprovalRequest,
  AVAILABLE_MODELS,
  type CodexidianSettings,
  EFFORT_OPTIONS,
  type McpToolCallRequest,
  type McpToolCallResult,
  type UserInputRequest,
  type UserInputResponse,
} from "./types";

export default class CodexidianPlugin extends Plugin {
  settings: CodexidianSettings = { ...DEFAULT_SETTINGS };
  client!: CodexAppServerClient;
  private mcpService!: VaultMcpService;

  async onload(): Promise<void> {
    await this.loadSettings();
    setLocale(this.settings.locale);
    this.mcpService = new VaultMcpService(
      this.app,
      () => ({
        blockedPatterns: this.settings.securityBlockedPaths,
        requireApprovalForWrite: this.settings.securityRequireApprovalForWrite,
        maxNoteSizeKb: this.settings.securityMaxNoteSize,
      }),
      async (request) => await this.requestMcpWriteApproval(request),
    );

    this.client = new CodexAppServerClient(
      () => this.settings,
      () => this.getVaultBasePath(),
      (threadId) => {
        if (!this.settings.persistThread) {
          return;
        }
        this.settings.lastThreadId = threadId;
        void this.saveSettings();
      },
      (message) => {
        const view = this.getOpenView();
        if (view) {
          view.appendSystemMessage(message);
          view.updateStatus();
        }
      },
      async (request) => await this.handleApprovalRequest(request),
      async (request) => await this.handleUserInputRequest(request),
      async (request) => await this.handleMcpToolCall(request),
    );

    this.registerView(
      VIEW_TYPE_CODEXIDIAN,
      (leaf: WorkspaceLeaf) => new CodexidianView(leaf, this),
    );

    this.addRibbonIcon("bot", t("openCodexidianCommand"), () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-codexidian",
      name: t("openCodexidianCommand"),
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "codexidian-new-thread",
      name: t("startNewThreadCommand"),
      callback: async () => {
        try {
          const threadId = await this.client.newThread();
          new Notice(tf("noticeNewThreadCreated", { threadId: threadId.slice(0, 8) }));
          this.refreshStatus();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(tf("noticeCodexError", { error: message }));
        }
      },
    });

    this.addSettingTab(new CodexidianSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CODEXIDIAN);
    if (this.client) {
      await this.client.dispose();
    }
  }

  getVaultBasePath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return process.cwd();
  }

  getOpenView(): CodexidianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEXIDIAN);
    if (leaves.length === 0) {
      return null;
    }

    const view = leaves[0].view;
    if (view instanceof CodexidianView) {
      return view;
    }
    return null;
  }

  private async handleApprovalRequest(request: ApprovalRequest): Promise<ApprovalDecision> {
    let view = this.getOpenView();
    if (!view) {
      await this.activateView();
      view = this.getOpenView();
    }
    if (!view) {
      throw new Error("Codexidian view is not available for approval.");
    }
    return await view.showApprovalCard(request);
  }

  private async handleUserInputRequest(request: UserInputRequest): Promise<UserInputResponse> {
    let view = this.getOpenView();
    if (!view) {
      await this.activateView();
      view = this.getOpenView();
    }
    if (!view) {
      throw new Error("Codexidian view is not available for user input.");
    }
    return await view.showUserInputCard(request);
  }

  private async handleMcpToolCall(request: McpToolCallRequest): Promise<McpToolCallResult> {
    if (!this.settings.enableMcp) {
      return {
        success: false,
        isError: true,
        contentItems: [{ type: "inputText", text: t("mcpDisabledMessage") }],
      };
    }

    try {
      return await this.mcpService.handleToolCall(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        isError: true,
        contentItems: [{ type: "inputText", text: tf("mcpToolExecutionFailed", { error: message }) }],
      };
    }
  }

  private async requestMcpWriteApproval(request: VaultMcpWriteApprovalRequest): Promise<boolean> {
    if (!this.settings.securityRequireApprovalForWrite) {
      return true;
    }

    try {
      const decision = await this.handleApprovalRequest({
        requestId: `mcp-write-${Date.now()}`,
        type: "fileChange",
        filePath: request.path,
        params: {
          source: "mcp/write_note",
          mode: request.mode,
          sizeBytes: request.contentBytes,
          preview: request.content.slice(0, 300),
        },
      });
      return decision === "accept";
    } catch {
      return false;
    }
  }

  async collectMcpContextForPrompt(
    prompt: string,
    currentNotePath: string | null,
    existingPaths: Set<string> = new Set<string>(),
  ): Promise<Array<{ path: string; content: string }>> {
    if (!this.settings.enableMcp) {
      return [];
    }

    const limit = this.settings.mcpContextNoteLimit;
    if (limit <= 0) {
      return [];
    }

    try {
      return await this.mcpService.collectRelatedNotes(prompt, currentNotePath, {
        limit,
        maxCharsPerNote: 8_000,
        excludePaths: existingPaths,
      });
    } catch {
      return [];
    }
  }

  refreshStatus(): void {
    const view = this.getOpenView();
    view?.updateStatus();
  }

  async activateView(): Promise<void> {
    const workspace = this.app.workspace;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_CODEXIDIAN)[0] ?? null;

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) {
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE_CODEXIDIAN, active: true });
    }

    workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<CodexidianSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
    if (!isLocale(this.settings.locale)) {
      this.settings.locale = DEFAULT_SETTINGS.locale;
    }
    setLocale(this.settings.locale);

    if (!this.settings.workingDirectory.trim()) {
      this.settings.workingDirectory = this.getVaultBasePath();
    }

    if (!Array.isArray(this.settings.securityBlockedPaths)) {
      this.settings.securityBlockedPaths = [...DEFAULT_SETTINGS.securityBlockedPaths];
    } else {
      this.settings.securityBlockedPaths = this.settings.securityBlockedPaths
        .map((pattern) => String(pattern).trim())
        .filter((pattern) => pattern.length > 0);
    }

    if (!Number.isFinite(this.settings.securityMaxNoteSize) || this.settings.securityMaxNoteSize <= 0) {
      this.settings.securityMaxNoteSize = DEFAULT_SETTINGS.securityMaxNoteSize;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class CodexidianSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CodexidianPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: t("settingsTitle") });

    new Setting(containerEl)
      .setName(t("settingLanguageName"))
      .setDesc(t("settingLanguageDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("zh", t("localeNameZh"))
          .addOption("en", t("localeNameEn"))
          .setValue(this.plugin.settings.locale)
          .onChange(async (value) => {
            if (!isLocale(value)) return;
            this.plugin.settings.locale = value;
            setLocale(value);
            await this.plugin.saveSettings();
            this.plugin.getOpenView()?.refreshLocale();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName(t("settingCodexCommandName"))
      .setDesc(t("settingCodexCommandDesc"))
      .addText((text) =>
        text
          .setPlaceholder("codex.cmd")
          .setValue(this.plugin.settings.codexCommand)
          .onChange(async (value) => {
            this.plugin.settings.codexCommand = value.trim() || DEFAULT_SETTINGS.codexCommand;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settingWorkingDirName"))
      .setDesc(t("settingWorkingDirDesc"))
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.getVaultBasePath())
          .setValue(this.plugin.settings.workingDirectory)
          .onChange(async (value) => {
            this.plugin.settings.workingDirectory = value.trim() || this.plugin.getVaultBasePath();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settingModelName"))
      .setDesc(t("settingModelDesc"))
      .addDropdown((dropdown) => {
        for (const m of AVAILABLE_MODELS) {
          dropdown.addOption(m.value, m.label);
        }
        dropdown
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settingEffortName"))
      .setDesc(t("settingEffortDesc"))
      .addDropdown((dropdown) => {
        for (const e of EFFORT_OPTIONS) {
          dropdown.addOption(e.value, e.label);
        }
        dropdown
          .setValue(this.plugin.settings.thinkingEffort)
          .onChange(async (value) => {
            this.plugin.settings.thinkingEffort = value as any;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settingApprovalPolicyName"))
      .setDesc(t("settingApprovalPolicyDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("on-request", "on-request")
          .addOption("never", "never")
          .addOption("untrusted", "untrusted")
          .addOption("on-failure", "on-failure")
          .setValue(this.plugin.settings.approvalPolicy)
          .onChange(async (value) => {
            this.plugin.settings.approvalPolicy = value as CodexidianSettings["approvalPolicy"];
            await this.plugin.saveSettings();
            this.plugin.refreshStatus();
          }),
      );

    new Setting(containerEl)
      .setName(t("settingSandboxName"))
      .setDesc(t("settingSandboxDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("workspace-write", "workspace-write")
          .addOption("read-only", "read-only")
          .addOption("danger-full-access", "danger-full-access")
          .setValue(this.plugin.settings.sandboxMode)
          .onChange(async (value) => {
            this.plugin.settings.sandboxMode = value as CodexidianSettings["sandboxMode"];
            await this.plugin.saveSettings();
            this.plugin.refreshStatus();
          }),
      );

    new Setting(containerEl)
      .setName(t("settingAutoApproveName"))
      .setDesc(t("settingAutoApproveDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoApproveRequests).onChange(async (value) => {
          this.plugin.settings.autoApproveRequests = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("settingPersistThreadName"))
      .setDesc(t("settingPersistThreadDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.persistThread).onChange(async (value) => {
          this.plugin.settings.persistThread = value;
          if (!value) {
            this.plugin.settings.lastThreadId = "";
            this.plugin.client.setThreadId(null);
          }
          await this.plugin.saveSettings();
          this.plugin.refreshStatus();
        }),
      );

    new Setting(containerEl)
      .setName(t("settingSavedThreadName"))
      .setDesc(this.plugin.settings.lastThreadId || t("settingSavedThreadEmpty"))
      .addButton((button) =>
        button.setButtonText(t("settingSavedThreadClear")).onClick(async () => {
          this.plugin.settings.lastThreadId = "";
          this.plugin.client.setThreadId(null);
          await this.plugin.saveSettings();
          this.display();
          this.plugin.refreshStatus();
          new Notice(t("noticeSavedThreadCleared"));
        }),
      );

    containerEl.createEl("h3", { text: t("settingsUiSection") });

    new Setting(containerEl)
      .setName(t("settingMaxTabsName"))
      .setDesc(t("settingMaxTabsDesc"))
      .addSlider((slider) =>
        slider
          .setLimits(1, 5, 1)
          .setValue(this.plugin.settings.maxTabs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxTabs = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settingContextInjectionName"))
      .setDesc(t("settingContextInjectionDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableContextInjection).onChange(async (value) => {
          this.plugin.settings.enableContextInjection = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("settingSelectionPollingName"))
      .setDesc(t("settingSelectionPollingDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableSelectionPolling).onChange(async (value) => {
          this.plugin.settings.enableSelectionPolling = value;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h3", { text: t("settingsMcpSection") });

    new Setting(containerEl)
      .setName(t("settingEnableMcpName"))
      .setDesc(t("settingEnableMcpDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableMcp).onChange(async (value) => {
          this.plugin.settings.enableMcp = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("settingMcpEndpointName"))
      .setDesc(t("settingMcpEndpointDesc"))
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:27124")
          .setValue(this.plugin.settings.mcpEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.mcpEndpoint = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settingMcpApiKeyName"))
      .setDesc(t("settingMcpApiKeyDesc"))
      .addText((text) =>
        text
          .setPlaceholder("API key")
          .setValue(this.plugin.settings.mcpApiKey)
          .onChange(async (value) => {
            this.plugin.settings.mcpApiKey = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settingMcpContextLimitName"))
      .setDesc(t("settingMcpContextLimitDesc"))
      .addSlider((slider) =>
        slider
          .setLimits(0, 8, 1)
          .setValue(this.plugin.settings.mcpContextNoteLimit)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.mcpContextNoteLimit = value;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h3", { text: t("settingsSecuritySection") });

    new Setting(containerEl)
      .setName(t("settingBlockedPathsName"))
      .setDesc(t("settingBlockedPathsDesc"))
      .addTextArea((textArea) => {
        textArea.inputEl.rows = 6;
        textArea
          .setPlaceholder(".obsidian/\n.codex/\n.env\n*.secret")
          .setValue(this.plugin.settings.securityBlockedPaths.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.securityBlockedPaths = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settingRequireApprovalWriteName"))
      .setDesc(t("settingRequireApprovalWriteDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.securityRequireApprovalForWrite).onChange(async (value) => {
          this.plugin.settings.securityRequireApprovalForWrite = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("settingMaxNoteSizeName"))
      .setDesc(t("settingMaxNoteSizeDesc"))
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.securityMaxNoteSize))
          .setValue(String(this.plugin.settings.securityMaxNoteSize))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value.trim(), 10);
            this.plugin.settings.securityMaxNoteSize = Number.isFinite(parsed) && parsed > 0
              ? parsed
              : DEFAULT_SETTINGS.securityMaxNoteSize;
            await this.plugin.saveSettings();
          }),
      );
  }
}
