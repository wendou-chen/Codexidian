import { ItemView, MarkdownView, normalizePath, Notice, TFile, WorkspaceLeaf } from "obsidian";

import type CodexidianPlugin from "./main";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  ConversationMeta,
  SlashCommand,
  TabManagerState,
  ToolCompleteInfo,
  ToolStartInfo,
  UserInputRequest,
  UserInputResponse,
} from "./types";
import { AVAILABLE_MODELS, EFFORT_OPTIONS, type ThinkingEffort } from "./types";
import { VaultFileAdapter } from "./storage/VaultFileAdapter";
import { SessionStorage } from "./storage/SessionStorage";
import { MessageRenderer } from "./rendering/MessageRenderer";
import {
  ThinkingBlockRenderer,
  type ThinkingBlockHandle,
} from "./rendering/ThinkingBlockRenderer";
import {
  ToolCallRenderer,
  type ToolCardHandle,
} from "./rendering/ToolCallRenderer";
import { ConversationController } from "./controllers/ConversationController";
import { SelectionController } from "./controllers/SelectionController";
import { TabBar } from "./tabs/TabBar";
import { TabManager, type Tab } from "./tabs/TabManager";
import { buildAugmentedPrompt } from "./utils/context";
import { FileContext } from "./ui/FileContext";
import { ImageContext } from "./ui/ImageContext";
import { SlashCommandMenu } from "./ui/SlashCommandMenu";
import { StatusPanel } from "./ui/StatusPanel";
import { PathValidator } from "./security/PathValidator";
import { t, tf } from "./i18n";

export const VIEW_TYPE_CODEXIDIAN = "codexidian-view";

export class CodexidianView extends ItemView {
  private rootEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private messagesContainer!: HTMLElement;
  private contextRowEl!: HTMLElement;
  private noteContextEl!: HTMLElement;
  private noteContextTextEl!: HTMLElement;
  private noteContextToggleEl!: HTMLButtonElement;
  private selectionContextEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private modelSelect!: HTMLSelectElement;
  private effortSelect!: HTMLSelectElement;
  private newThreadBtn!: HTMLButtonElement;
  private restartBtn!: HTMLButtonElement;
  private historyBtn!: HTMLButtonElement;
  private historyMenuEl!: HTMLElement;

  private vaultAdapter!: VaultFileAdapter;
  private sessionStorage!: SessionStorage;
  private messageRenderer!: MessageRenderer;
  private thinkingRenderer!: ThinkingBlockRenderer;
  private toolCallRenderer!: ToolCallRenderer;
  private selectionController!: SelectionController;
  private fileContext: FileContext | null = null;
  private imageContext: ImageContext | null = null;
  private slashMenu: SlashCommandMenu | null = null;
  private statusPanel: StatusPanel | null = null;
  private tabManager!: TabManager;
  private tabBar!: TabBar;

  private running = false;
  private historyOpen = false;
  private messageQueue: string[] = [];
  private currentTurnId: string | null = null;
  private queueIndicatorEl: HTMLElement | null = null;
  private sendHintEl: HTMLElement | null = null;
  private modelLabelEl: HTMLElement | null = null;
  private effortLabelEl: HTMLElement | null = null;
  private sendSequence = 0;
  private cancelledSendSequences = new Set<number>();
  private includeCurrentNoteContent = false;
  private ctrlEnterHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexidianPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_CODEXIDIAN; }
  getDisplayText(): string { return t("appTitle"); }
  getIcon(): string { return "bot"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    // Init storage
    this.vaultAdapter = new VaultFileAdapter(this.app);
    this.sessionStorage = new SessionStorage(this.vaultAdapter);
    let storageInitError: string | null = null;
    try {
      await this.sessionStorage.init();
    } catch (error) {
      storageInitError = error instanceof Error ? error.message : String(error);
      new Notice(tf("noticeStorageInitFailed", { error: storageInitError }));
    }

    // Init renderer
    this.messageRenderer = new MessageRenderer(this.app, this, async (request) => {
      await this.applyCodeToNote(request.code, request.language, request.triggerEl);
    });
    this.thinkingRenderer = new ThinkingBlockRenderer();
    this.toolCallRenderer = new ToolCallRenderer();

    // Build DOM
    this.rootEl = container.createDiv({ cls: "codexidian-view" });

    // Header
    const headerEl = this.rootEl.createDiv({ cls: "codexidian-header" });
    const headerLeft = headerEl.createDiv({ cls: "codexidian-header-left" });
    this.titleEl = headerLeft.createDiv({ cls: "codexidian-title", text: t("appTitle") });
    this.statusEl = headerLeft.createDiv({ cls: "codexidian-status", text: t("disconnected") });

    // Tab bar container
    const tabBarContainer = headerEl.createDiv({ cls: "codexidian-tab-bar-container" });

    // Header right buttons
    const headerRight = headerEl.createDiv({ cls: "codexidian-header-right" });
    headerRight.style.position = "relative";
    this.historyBtn = headerRight.createEl("button", { text: t("history") });
    this.newThreadBtn = headerRight.createEl("button", { text: t("newThread") });
    this.restartBtn = headerRight.createEl("button", { text: t("restart") });

    // History menu (hidden by default)
    this.historyMenuEl = headerRight.createDiv({ cls: "codexidian-history-menu" });
    this.historyMenuEl.style.display = "none";

    // Messages container (holds tab panels)
    this.messagesContainer = this.rootEl.createDiv({ cls: "codexidian-messages-container" });

    // Context row
    this.contextRowEl = this.rootEl.createDiv({ cls: "codexidian-context-row" });
    this.noteContextEl = this.contextRowEl.createDiv({ cls: "codexidian-note-context" });
    this.noteContextTextEl = this.noteContextEl.createSpan({ cls: "codexidian-note-context-text" });
    this.noteContextToggleEl = this.noteContextEl.createEl("button", {
      cls: "codexidian-note-context-toggle",
    });
    this.noteContextToggleEl.addEventListener("click", () => {
      this.includeCurrentNoteContent = !this.includeCurrentNoteContent;
      this.updateNoteContextToggle();
    });
    this.selectionContextEl = this.contextRowEl.createDiv({ cls: "codexidian-selection-context" });
    this.updateNoteContextToggle();

    const statusPanelEl = this.rootEl.createDiv({ cls: "codexidian-status-panel" });
    this.statusPanel = new StatusPanel(statusPanelEl);

    // Footer
    const footerEl = this.rootEl.createDiv({ cls: "codexidian-footer" });
    const fileChipContainerEl = footerEl.createDiv({ cls: "codexidian-file-chips-container" });
    const imagePreviewContainerEl = footerEl.createDiv({ cls: "codexidian-image-previews-container" });
    const inputWrapEl = footerEl.createDiv({ cls: "codexidian-input-wrap" });
    this.inputEl = inputWrapEl.createEl("textarea", { cls: "codexidian-input" });
    this.inputEl.placeholder = t("askPlaceholder");
    this.slashMenu = new SlashCommandMenu(inputWrapEl);
    this.registerBuiltinSlashCommands();

    // Model + Effort toolbar
    const toolbarEl = footerEl.createDiv({ cls: "codexidian-toolbar" });

    const modelGroup = toolbarEl.createDiv({ cls: "codexidian-toolbar-group" });
    this.modelLabelEl = modelGroup.createSpan({ cls: "codexidian-toolbar-label", text: t("model") });
    this.modelSelect = modelGroup.createEl("select", { cls: "codexidian-toolbar-select" });
    for (const m of AVAILABLE_MODELS) {
      const opt = this.modelSelect.createEl("option", { text: m.label, value: m.value });
      if (m.value === this.plugin.settings.model) opt.selected = true;
    }
    this.modelSelect.addEventListener("change", () => {
      this.plugin.settings.model = this.modelSelect.value;
      void this.plugin.saveSettings();
    });

    const effortGroup = toolbarEl.createDiv({ cls: "codexidian-toolbar-group" });
    this.effortLabelEl = effortGroup.createSpan({ cls: "codexidian-toolbar-label", text: t("effort") });
    this.effortSelect = effortGroup.createEl("select", { cls: "codexidian-toolbar-select" });
    for (const e of EFFORT_OPTIONS) {
      const opt = this.effortSelect.createEl("option", { text: e.label, value: e.value });
      if (e.value === this.plugin.settings.thinkingEffort) opt.selected = true;
    }
    this.effortSelect.addEventListener("change", () => {
      this.plugin.settings.thinkingEffort = this.effortSelect.value as ThinkingEffort;
      void this.plugin.saveSettings();
    });

    const actionsEl = footerEl.createDiv({ cls: "codexidian-actions" });
    this.sendHintEl = actionsEl.createDiv({ cls: "codexidian-hint", text: t("sendShortcutHint") });
    this.sendBtn = actionsEl.createEl("button", { text: t("send") });
    this.queueIndicatorEl = footerEl.createDiv({ cls: "codexidian-queue-indicator" });
    this.updateQueueIndicator();

    // Init TabBar
    this.tabBar = new TabBar(tabBarContainer, {
      maxTabs: this.plugin.settings.maxTabs,
      onSelect: (tabId) => this.tabManager.switchTo(tabId),
      onClose: (tabId) => this.tabManager.closeTab(tabId),
      onAdd: () => this.createNewTab(),
    });

    // Init TabManager
    this.tabManager = new TabManager(
      this.tabBar,
      this.messagesContainer,
      () => new ConversationController(this.sessionStorage, this.messageRenderer),
      this.plugin.client,
      (tab) => this.onTabSwitched(tab),
    );

    // Init SelectionController
    this.selectionController = new SelectionController(this.app);
    this.selectionController.setEnabled(this.plugin.settings.enableSelectionPolling);
    this.selectionController.setOnContextChanged(() => this.updateContextRowVisibility());
    this.selectionController.start(this.selectionContextEl);

    try {
      this.fileContext = new FileContext(this.app, fileChipContainerEl, this.inputEl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(tf("noticeFileContextInitFailed", { error: message }));
      this.fileContext = null;
    }
    try {
      this.imageContext = new ImageContext(imagePreviewContainerEl, this.inputEl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(tf("noticeImageContextInitFailed", { error: message }));
      this.imageContext = null;
    }

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.refreshCurrentNoteContext();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.refreshCurrentNoteContext();
    }));
    this.refreshCurrentNoteContext();

    try {
      await this.restoreTabsWithFallback();
      const activeTab = this.tabManager.getActiveTab();
      if (activeTab) {
        await this.ensureConversationReady(activeTab);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(tf("noticeRestoreTabsFailed", { error: message }));
      if (!this.tabManager.getActiveTab()) {
        await this.createNewTab();
      }
    }

    if (storageInitError) {
      const tab = this.tabManager.getActiveTab();
      if (tab) {
        this.appendSystemMessageToPanel(
          tab.panelEl,
          tf("noticeStorageInitFailed", { error: storageInitError }),
        );
      }
    }

    this.bindEvents();
    this.updateStatus();
  }

  async onClose(): Promise<void> {
    try {
      const settings = this.plugin.settings as any;
      if (this.tabManager) {
        settings._tabManagerState = this.tabManager.getState();
      }
      await this.plugin.saveSettings();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(tf("noticePersistTabStateFailed", { error: message }));
    }

    this.selectionController?.stop();
    this.selectionController?.setOnContextChanged(null);
    this.fileContext?.destroy();
    this.fileContext = null;
    this.imageContext?.destroy();
    this.imageContext = null;
    this.slashMenu?.destroy();
    this.slashMenu = null;
    this.messageRenderer?.destroy();
    this.statusPanel?.destroy();
    this.statusPanel = null;
    this.tabManager?.destroy();
    if (this.ctrlEnterHandler) {
      document.removeEventListener("keydown", this.ctrlEnterHandler, true);
      this.ctrlEnterHandler = null;
    }
  }

  private bindEvents(): void {
    this.sendBtn.addEventListener("click", () => {
      void this.sendCurrentInput().catch((error) => this.handleUnhandledSendError(error));
    });
    this.inputEl.addEventListener("input", () => {
      this.handleSlashInputChanged();
    });

    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        this.debugLog("Enter pressed", {
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          slashMenuVisible: this.slashMenu?.isVisible() || false,
          running: this.running,
          inputDisabled: this.inputEl.disabled,
        });
      }

      if (this.slashMenu?.isVisible()) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          this.slashMenu.selectNext();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          this.slashMenu.selectPrev();
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          void this.executeSelectedSlashCommand();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.slashMenu.hide();
          return;
        }
      }

      if (e.key === "Escape" && this.running) {
        e.preventDefault();
        e.stopPropagation();
        void this.cancelCurrentStream();
        return;
      }
    });

    // Document-level capture to intercept Ctrl+Enter before Obsidian/Electron swallows it.
    if (this.ctrlEnterHandler) {
      document.removeEventListener("keydown", this.ctrlEnterHandler, true);
    }
    this.ctrlEnterHandler = (e: KeyboardEvent) => {
      if (document.activeElement !== this.inputEl) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        console.log("[CODEXIDIAN DEBUG] Ctrl+Enter captured at document level");
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        void this.sendCurrentInput().catch((error) => this.handleUnhandledSendError(error));
      }
    };
    document.addEventListener("keydown", this.ctrlEnterHandler, true);

    // Backup handler managed by Obsidian lifecycle.
    this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
      if (document.activeElement !== this.inputEl) return;
      if (event.defaultPrevented) return;
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        console.log("[CODEXIDIAN DEBUG] Ctrl+Enter captured via registerDomEvent");
        event.preventDefault();
        event.stopPropagation();
        void this.sendCurrentInput().catch((error) => this.handleUnhandledSendError(error));
      }
    });

    this.newThreadBtn.addEventListener("click", () => void this.startNewThread());
    this.restartBtn.addEventListener("click", () => void this.restartEngine());
    this.historyBtn.addEventListener("click", () => this.toggleHistory());
  }

  private registerBuiltinSlashCommands(): void {
    if (!this.slashMenu) return;

    const register = (command: SlashCommand): void => {
      this.slashMenu?.registerCommand({
        ...command,
        execute: async () => {
          this.inputEl.value = "";
          this.slashMenu?.hide();
          await command.execute();
          this.inputEl.focus();
        },
      });
    };

    register({
      name: "new",
      label: t("cmdNewLabel"),
      description: t("cmdNewDesc"),
      icon: "➕",
      execute: async () => {
        const tabCount = this.tabManager.getAllTabStates().length;
        if (tabCount >= this.plugin.settings.maxTabs) {
          new Notice(tf("noticeCannotCreateTabMax", { max: this.plugin.settings.maxTabs }));
          return;
        }
        await this.createNewTab();
      },
    });

    register({
      name: "clear",
      label: t("cmdClearLabel"),
      description: t("cmdClearDesc"),
      icon: "🧹",
      execute: async () => {
        await this.clearCurrentConversationMessages();
      },
    });

    register({
      name: "model",
      label: t("cmdModelLabel"),
      description: t("cmdModelDesc"),
      icon: "🤖",
      execute: async () => {
        await this.cycleModelSetting();
      },
    });

    register({
      name: "effort",
      label: t("cmdEffortLabel"),
      description: t("cmdEffortDesc"),
      icon: "🧠",
      execute: async () => {
        await this.cycleEffortSetting();
      },
    });

    register({
      name: "history",
      label: t("cmdHistoryLabel"),
      description: t("cmdHistoryDesc"),
      icon: "🕘",
      execute: () => {
        this.toggleHistory();
      },
    });

    register({
      name: "tabs",
      label: t("cmdTabsLabel"),
      description: t("cmdTabsDesc"),
      icon: "🗂",
      execute: () => {
        this.showTabsSummary();
      },
    });

    register({
      name: "help",
      label: t("cmdHelpLabel"),
      description: t("cmdHelpDesc"),
      icon: "❓",
      execute: () => {
        this.showSlashCommandHelp();
      },
    });
  }

  private handleSlashInputChanged(): void {
    if (!this.slashMenu) return;
    const value = this.inputEl.value;
    if (!value.startsWith("/")) {
      this.slashMenu.hide();
      return;
    }
    const filter = this.extractSlashFilter(value);
    this.slashMenu.show(filter);
  }

  private async executeSelectedSlashCommand(): Promise<void> {
    const executed = await this.slashMenu?.executeSelected();
    if (!executed) return;
    this.inputEl.value = "";
    this.inputEl.focus();
  }

  private async executeSlashCommandByName(name: string): Promise<boolean> {
    const executed = await this.slashMenu?.executeByName(name);
    if (!executed) return false;
    this.inputEl.value = "";
    this.slashMenu?.hide();
    this.inputEl.focus();
    return true;
  }

  private extractSlashFilter(value: string): string {
    if (!value.startsWith("/")) {
      return "";
    }
    const withoutPrefix = value.slice(1).trimStart();
    const [token] = withoutPrefix.split(/\s+/, 1);
    return (token ?? "").trim().toLowerCase();
  }

  private extractSlashCommandName(value: string): string | null {
    if (!value.startsWith("/")) {
      return null;
    }
    const name = this.extractSlashFilter(value);
    return name.length > 0 ? name : null;
  }

  private async clearCurrentConversationMessages(): Promise<void> {
    const tab = this.tabManager.getActiveTab();
    if (!tab) {
      new Notice(t("noticeNoActiveTabToClear"));
      return;
    }

    const ready = await this.ensureConversationReady(tab);
    if (!ready) {
      return;
    }

    tab.panelEl.empty();
    tab.conversationController.setMessages([]);
    this.statusPanel?.clear();
    new Notice(t("noticeClearedConversation"));
  }

  private async cycleModelSetting(): Promise<void> {
    const currentValue = this.plugin.settings.model;
    const currentIndex = AVAILABLE_MODELS.findIndex((model) => model.value === currentValue);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextModel = AVAILABLE_MODELS[(safeIndex + 1) % AVAILABLE_MODELS.length];

    this.plugin.settings.model = nextModel.value;
    this.modelSelect.value = nextModel.value;
    await this.plugin.saveSettings();
    this.updateStatus();
    new Notice(tf("noticeModelSet", { model: nextModel.label }));
  }

  private async cycleEffortSetting(): Promise<void> {
    const values = EFFORT_OPTIONS.map((option) => option.value);
    const currentValue = this.plugin.settings.thinkingEffort;
    const currentIndex = values.indexOf(currentValue);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextOption = EFFORT_OPTIONS[(safeIndex + 1) % EFFORT_OPTIONS.length];

    this.plugin.settings.thinkingEffort = nextOption.value as ThinkingEffort;
    this.effortSelect.value = nextOption.value;
    await this.plugin.saveSettings();
    this.updateStatus();
    new Notice(tf("noticeEffortSet", { effort: nextOption.label }));
  }

  private showTabsSummary(): void {
    const tabStates = this.tabManager.getAllTabStates();
    if (tabStates.length === 0) {
      this.appendSystemMessage(t("messageNoTabsOpen"));
      return;
    }

    const activeTabId = this.tabManager.getActiveTab()?.state.tabId ?? null;
    const summary = tabStates.map((state, index) => {
      const activeFlag = state.tabId === activeTabId ? "*" : "";
      const shortTabId = state.tabId.slice(-4);
      const conv = state.conversationId ? state.conversationId.slice(-6) : "none";
      return `${activeFlag}${index + 1}[${shortTabId}] conv:${conv}`;
    }).join(" | ");

    this.appendSystemMessage(tf("messageTabsSummary", {
      count: tabStates.length,
      max: this.plugin.settings.maxTabs,
      summary,
    }));
  }

  private showSlashCommandHelp(): void {
    const commands = this.slashMenu?.getCommands() ?? [];
    if (commands.length === 0) {
      this.appendSystemMessage(t("messageNoSlashCommands"));
      return;
    }

    const helpText = commands
      .map((command) => `/${command.name}: ${command.description}`)
      .join(" | ");
    this.appendSystemMessage(tf("messageAvailableSlashCommands", { list: helpText }));
  }

  private updateQueueIndicator(): void {
    if (!this.queueIndicatorEl) return;
    const queued = this.messageQueue.length;
    if (queued <= 0) {
      this.queueIndicatorEl.removeClass("visible");
      this.queueIndicatorEl.setText("");
      return;
    }
    this.queueIndicatorEl.setText(queued === 1
      ? tf("messageQueuedCount", { count: queued })
      : tf("messageQueuedCountPlural", { count: queued }));
    this.queueIndicatorEl.addClass("visible");
  }

  private async cancelCurrentStream(): Promise<void> {
    if (!this.running) return;

    const activeSeq = this.sendSequence;
    this.cancelledSendSequences.add(activeSeq);

    const turnId = this.currentTurnId ?? this.plugin.client.getCurrentTurnId();
    this.currentTurnId = turnId;

    const activeTab = this.tabManager?.getActiveTab();
    if (activeTab) {
      this.tabBar.setStreaming(activeTab.state.tabId, false);
      this.appendSystemMessageToPanel(activeTab.panelEl, t("messageCancelledByUser"));
    }

    this.running = false;
    this.updateStatus();
    this.statusPanel?.setTurnStatus("idle");
    this.statusPanel?.clearFinishedAfterDelay(3000);

    try {
      if (turnId) {
        await this.plugin.client.cancelTurn(turnId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (activeTab) {
        this.appendSystemMessageToPanel(activeTab.panelEl, tf("messageCancelRequestFailed", { error: message }));
      }
    } finally {
      this.currentTurnId = null;
    }

    try {
      await this.processQueue();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(tf("noticeProcessQueueFailed", { error: message }));
    }
  }

  private async processQueue(): Promise<void> {
    if (this.running) return;
    const nextPrompt = this.messageQueue.shift();
    this.updateQueueIndicator();
    if (!nextPrompt) return;
    try {
      await this.sendCurrentInput(nextPrompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const activeTab = this.tabManager?.getActiveTab();
      if (activeTab) {
        this.appendSystemMessageToPanel(activeTab.panelEl, tf("messageQueuedSendFailed", { error: message }));
      }
    }
  }

  private async createNewTab(): Promise<void> {
    const tab = this.tabManager.addTab();
    try {
      const conv = await tab.conversationController.createNew();
      this.tabManager.setConversationId(tab.state.tabId, conv.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendSystemMessageToPanel(tab.panelEl, tf("messageFailedInitConversation", { error: message }));
    }
    this.appendSystemMessageToPanel(tab.panelEl, t("messageReadyHint"));
  }

  private async restoreTabConversation(tab: Tab): Promise<void> {
    if (!tab.state.conversationId) {
      await this.ensureConversationReady(tab);
      return;
    }

    try {
      const conv = await tab.conversationController.switchTo(tab.state.conversationId);
      if (!conv) {
        this.tabManager.setConversationId(tab.state.tabId, null);
        await this.ensureConversationReady(tab);
        return;
      }

      await this.renderConversationMessages(tab.panelEl, conv.messages);

      // Restore thread
      if (conv.threadId) {
        this.plugin.client.setThreadId(conv.threadId);
      }
    } catch {
      this.tabManager.setConversationId(tab.state.tabId, null);
      await this.ensureConversationReady(tab);
    }
  }

  private onTabSwitched(tab: Tab): void {
    this.updateStatus();
    // Scroll to bottom of active panel
    tab.panelEl.scrollTop = tab.panelEl.scrollHeight;
  }

  private async ensureConversationReady(tab: Tab): Promise<boolean> {
    const active = tab.conversationController.getActive();
    if (active) {
      if (!tab.state.conversationId || tab.state.conversationId !== active.id) {
        this.tabManager.setConversationId(tab.state.tabId, active.id);
      }
      return true;
    }

    try {
      const conv = await tab.conversationController.createNew();
      this.tabManager.setConversationId(tab.state.tabId, conv.id);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendSystemMessageToPanel(tab.panelEl, tf("messageFailedInitConversation", { error: message }));
      new Notice(tf("noticeCodexError", { error: message }));
      return false;
    }
  }

  private handleUnhandledSendError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.debugError("handleUnhandledSendError", error);
    const tab = this.tabManager?.getActiveTab();
    if (tab) {
      this.appendSystemMessageToPanel(tab.panelEl, tf("messageRequestFailed", { error: message }));
    }
    new Notice(tf("noticeCodexError", { error: message }));
    this.running = false;
    this.currentTurnId = null;
    this.statusPanel?.setTurnStatus("idle");
    this.statusPanel?.clearFinishedAfterDelay(3000);
    this.updateStatus();
  }

  private async sendCurrentInput(promptOverride?: string): Promise<void> {
    this.debugLog("sendCurrentInput:entry", {
      hasOverride: promptOverride !== undefined,
      running: this.running,
      queueLength: this.messageQueue.length,
    });
    const rawPrompt = promptOverride ?? this.inputEl.value;
    const prompt = rawPrompt.trim();
    if (!prompt) {
      this.debugLog("sendCurrentInput:skip-empty");
      return;
    }

    const slashCommandName = this.extractSlashCommandName(prompt);
    if (slashCommandName) {
      const executed = await this.executeSlashCommandByName(slashCommandName);
      if (executed) {
        this.debugLog("sendCurrentInput:slash-executed", { slashCommandName });
        if (promptOverride === undefined) {
          this.inputEl.value = "";
        }
        return;
      }
    }

    if (this.running) {
      this.messageQueue.push(prompt);
      this.debugLog("sendCurrentInput:queued", {
        queueLength: this.messageQueue.length,
      });
      if (promptOverride === undefined) {
        this.inputEl.value = "";
      }
      this.updateQueueIndicator();
      return;
    }

    if (!this.tabManager) return;

    let tab = this.tabManager.getActiveTab();
    if (!tab) {
      this.debugLog("sendCurrentInput:no-active-tab, creating");
      await this.createNewTab();
      tab = this.tabManager.getActiveTab();
    }
    if (!tab) {
      this.debugLog("sendCurrentInput:abort-no-tab");
      return;
    }

    const conversationReady = await this.ensureConversationReady(tab);
    if (!conversationReady) {
      this.debugLog("sendCurrentInput:abort-conversation-not-ready");
      return;
    }

    const cc = tab.conversationController;
    if (promptOverride === undefined) {
      this.inputEl.value = "";
    }

    // Build augmented prompt with context
    let notePath: string | null = null;
    try {
      notePath = this.getCurrentMarkdownNotePath();
    } catch (error) {
      this.debugError("sendCurrentInput:notePath-failed", error);
    }

    let editorCtx = null;
    try {
      editorCtx = this.plugin.settings.enableContextInjection
        ? (this.selectionController?.getContext() ?? null)
        : null;
    } catch (error) {
      this.debugError("sendCurrentInput:editorCtx-failed", error);
      editorCtx = null;
    }

    let attachedFiles: Array<{ path: string; content: string }> = [];
    try {
      attachedFiles = await this.collectAttachedFileContents(notePath, tab.panelEl);
    } catch (error) {
      this.debugError("sendCurrentInput:collectAttachedFileContents-failed", error);
      attachedFiles = [];
    }

    const existingPaths = new Set(attachedFiles.map((file) => file.path));
    let mcpContextFiles: Array<{ path: string; content: string }> = [];
    try {
      mcpContextFiles = await this.plugin.collectMcpContextForPrompt(prompt, notePath, existingPaths);
    } catch (error) {
      this.debugError("sendCurrentInput:mcpContext-failed", error);
      mcpContextFiles = [];
    }

    const allContextFiles = [...attachedFiles];
    if (mcpContextFiles.length > 0) {
      for (const file of mcpContextFiles) {
        if (existingPaths.has(file.path)) continue;
        existingPaths.add(file.path);
        allContextFiles.push(file);
      }
      try {
        this.appendSystemMessageToPanel(
          tab.panelEl,
          tf("messageMcpContextAttached", { paths: mcpContextFiles.map((file) => file.path).join(", ") }),
        );
      } catch (error) {
        this.debugError("sendCurrentInput:mcpContext-notice-failed", error);
      }
    }

    let imageAttachments: Array<{ name: string; dataUrl: string }> = [];
    try {
      imageAttachments = this.imageContext?.getImages() ?? [];
    } catch (error) {
      this.debugError("sendCurrentInput:imageContext-failed", error);
      imageAttachments = [];
    }
    const imageLines = imageAttachments.map((image) => (
      tf("imageAttached", { name: image.name || "pasted-image" })
    ));
    const promptWithImages = imageLines.length > 0
      ? `${prompt}\n\n${imageLines.join("\n")}`
      : prompt;
    let augmented = promptWithImages;
    try {
      augmented = buildAugmentedPrompt(promptWithImages, notePath, editorCtx, allContextFiles);
    } catch (error) {
      this.debugError("sendCurrentInput:buildAugmentedPrompt-failed", error);
      augmented = promptWithImages;
    }

    this.debugLog("sendCurrentInput:prompt-ready", {
      promptLength: prompt.length,
      augmentedLength: augmented.length,
      attachedFiles: attachedFiles.length,
      mcpContextFiles: mcpContextFiles.length,
      imageAttachments: imageAttachments.length,
      notePath,
    });

    // Show user message (original text only)
    let assistantEl: HTMLElement;
    try {
      const userMessage = cc.addMessage("user", prompt);
      this.appendMessageToPanel(tab.panelEl, "user", prompt, userMessage.id);
      // Create assistant message element for streaming
      assistantEl = this.createMessageEl(tab.panelEl, "assistant");
    } catch (error) {
      this.debugError("sendCurrentInput:pre-send-render-failed", error);
      throw error;
    }
    let accumulated = "";
    const sendSeq = ++this.sendSequence;
    const toolCards = new Map<string, ToolCardHandle>();
    const runningToolIds = new Set<string>();
    let activeToolItemId: string | null = null;
    let fallbackToolIndex = 0;
    let thinkingBlock: ThinkingBlockHandle | null = null;
    let thinkingFinalized = false;
    const toolStartTimes = new Map<string, number>();
    let thinkingEntryId: string | null = null;
    let thinkingStartedAt = 0;

    const createTimelineSlot = (): HTMLElement => {
      const slotEl = tab.panelEl.createDiv();
      const assistantWrapperEl = assistantEl.closest(".codexidian-msg-wrapper");
      const referenceEl = assistantWrapperEl instanceof HTMLElement
        ? assistantWrapperEl
        : assistantEl;
      if (referenceEl.parentElement === tab.panelEl) {
        tab.panelEl.insertBefore(slotEl, referenceEl);
      }
      return slotEl;
    };

    const finalizeThinking = (): void => {
      if (thinkingFinalized || !thinkingBlock) return;
      thinkingFinalized = true;
      thinkingBlock.finalize();
      if (thinkingEntryId) {
        this.statusPanel?.updateEntry(thinkingEntryId, {
          status: "completed",
          duration: Date.now() - thinkingStartedAt,
        });
        thinkingEntryId = null;
        thinkingStartedAt = 0;
      }
    };

    const ensureThinkingEntry = (): void => {
      if (thinkingEntryId) return;
      thinkingEntryId = `thinking-${sendSeq}`;
      thinkingStartedAt = Date.now();
      this.statusPanel?.addEntry({
        id: thinkingEntryId,
        type: "thinking",
        label: t("reasoning"),
        status: "running",
      });
    };

    const ensureToolCard = (
      itemId: string,
      info?: Partial<ToolStartInfo> & { type?: string },
    ): ToolCardHandle => {
      const existing = toolCards.get(itemId);
      if (existing) return existing;
      const card = this.toolCallRenderer.createCard(createTimelineSlot(), {
        type: info?.type ?? "tool",
        name: info?.name,
        command: info?.command,
        filePath: info?.filePath,
      });
      toolCards.set(itemId, card);
      return card;
    };

    this.running = true;
    this.currentTurnId = null;
    this.updateStatus();
    this.statusPanel?.setTurnStatus("thinking");
    this.tabBar.setStreaming(tab.state.tabId, true);

    try {
      this.debugLog("sendCurrentInput:before-sendTurn", {
        sendSeq,
        tabId: tab.state.tabId,
        model: this.modelSelect.value || "(default)",
        effort: this.effortSelect.value || "(default)",
      });
      const turnPromise = this.plugin.client.sendTurn(
        augmented,
        {
          onDelta: (delta) => {
            this.debugLog("sendCurrentInput:onDelta", {
              sendSeq,
              deltaLength: delta.length,
            });
            if (!this.currentTurnId) {
              this.currentTurnId = this.plugin.client.getCurrentTurnId();
            }
            if (thinkingEntryId) {
              this.statusPanel?.updateEntry(thinkingEntryId, {
                status: "completed",
                duration: Date.now() - thinkingStartedAt,
              });
              thinkingEntryId = null;
              thinkingStartedAt = 0;
            }
            this.statusPanel?.setTurnStatus("streaming");
            accumulated += delta;
            this.messageRenderer.renderStreaming(assistantEl, accumulated);
            tab.panelEl.scrollTop = tab.panelEl.scrollHeight;
          },
          onThinkingDelta: (delta) => {
            this.debugLog("sendCurrentInput:onThinkingDelta", {
              sendSeq,
              deltaLength: delta.length,
            });
            if (!delta) return;
            this.statusPanel?.setTurnStatus("thinking");
            ensureThinkingEntry();
            if (!thinkingBlock) {
              thinkingBlock = this.thinkingRenderer.createBlock(createTimelineSlot());
            }
            thinkingBlock.appendContent(delta);
            tab.panelEl.scrollTop = tab.panelEl.scrollHeight;
          },
          onToolStart: (info: ToolStartInfo) => {
            this.debugLog("sendCurrentInput:onToolStart", {
              sendSeq,
              itemId: info.itemId,
              type: info.type,
              name: info.name,
            });
            const card = ensureToolCard(info.itemId, info);
            runningToolIds.add(info.itemId);
            activeToolItemId = info.itemId;
            card.complete("running");
            toolStartTimes.set(info.itemId, Date.now());
            this.statusPanel?.setTurnStatus("tool_calling");
            this.statusPanel?.addEntry({
              id: info.itemId,
              type: "tool_call",
              label: info.name || info.type || "Tool",
              detail: this.truncateStatusDetail(info.command || info.filePath),
              status: "running",
            });
            tab.panelEl.scrollTop = tab.panelEl.scrollHeight;
          },
          onToolDelta: (delta) => {
            this.debugLog("sendCurrentInput:onToolDelta", {
              sendSeq,
              deltaLength: delta.length,
            });
            if (!this.currentTurnId) {
              this.currentTurnId = this.plugin.client.getCurrentTurnId();
            }
            this.statusPanel?.setTurnStatus("tool_calling");

            if (delta.length > 0) {
              let itemId = activeToolItemId;
              if (!itemId) {
                itemId = `tool-fallback-${sendSeq}-${++fallbackToolIndex}`;
                activeToolItemId = itemId;
                runningToolIds.add(itemId);
              }
              const card = ensureToolCard(itemId, { type: "tool", name: t("toolOutput") });
              card.appendOutput(delta);
            }

            if (delta.trim().length > 0) {
              this.statusEl.setText(`${t("toolStatusPrefix")}: ${delta.trim().slice(0, 80)}`);
            }
          },
          onToolComplete: (info: ToolCompleteInfo) => {
            this.debugLog("sendCurrentInput:onToolComplete", {
              sendSeq,
              itemId: info.itemId,
              status: info.status,
            });
            const card = ensureToolCard(info.itemId, info);
            card.complete(info.status);
            const startedAt = toolStartTimes.get(info.itemId);
            this.statusPanel?.updateEntry(info.itemId, {
              status: this.resolveEntryStatus(info.status),
              duration: startedAt ? Date.now() - startedAt : undefined,
            });
            runningToolIds.delete(info.itemId);
            if (activeToolItemId === info.itemId) {
              const remaining = Array.from(runningToolIds);
              activeToolItemId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
            }
            tab.panelEl.scrollTop = tab.panelEl.scrollHeight;
          },
          onSystem: (message) => {
            this.debugLog("sendCurrentInput:onSystem", {
              sendSeq,
              message,
            });
            this.appendSystemMessageToPanel(tab.panelEl, message);
          },
        },
        {
          model: this.modelSelect.value || undefined,
          effort: this.effortSelect.value || undefined,
        },
      );
      const captureTurnId = () => {
        if (this.currentTurnId || !this.running || sendSeq !== this.sendSequence) {
          return;
        }
        const activeTurnId = this.plugin.client.getCurrentTurnId();
        if (activeTurnId) {
          this.currentTurnId = activeTurnId;
          return;
        }
        window.setTimeout(captureTurnId, 25);
      };
      captureTurnId();
      const result = await turnPromise;
      this.debugLog("sendCurrentInput:onComplete", {
        sendSeq,
        turnId: result.turnId,
        status: result.status,
        hasErrorMessage: Boolean(result.errorMessage),
      });
      this.currentTurnId = result.turnId;
      this.statusPanel?.setTurnStatus("streaming");
      const cancelledByUser = this.cancelledSendSequences.has(sendSeq);

      // Final render
      if (accumulated.trim().length === 0) {
        if (cancelledByUser || result.status === "cancelled") {
          accumulated = t("messageCancelledByUser");
        } else {
          accumulated = result.errorMessage || t("messageNoAssistantOutput");
        }
      }
      await this.messageRenderer.renderContent(assistantEl, accumulated);
      finalizeThinking();

      // Save thread ID to conversation
      if (result.threadId) {
        cc.setThreadId(result.threadId);
      }

      // Persist assistant message
      cc.addMessage("assistant", accumulated);

      if (result.status !== "completed" && !(cancelledByUser && result.status === "cancelled")) {
        const suffix = result.errorMessage ? `: ${result.errorMessage}` : "";
        this.appendSystemMessageToPanel(tab.panelEl, tf("messageTurnFinishedStatus", {
          status: result.status,
          suffix,
        }));
      }
    } catch (error) {
      this.debugError("sendCurrentInput:onError", error, { sendSeq });
      const cancelledByUser = this.cancelledSendSequences.has(sendSeq);
      const message = error instanceof Error ? error.message : String(error);

      if (this.isThreadNotFoundMessage(message)) {
        this.debugLog("sendCurrentInput:thread-reset", {
          reason: message,
          tabId: tab.state.tabId,
        });
        cc.clearThreadId();
        this.plugin.client.setThreadId(null);
      }

      if (cancelledByUser) {
        const finalText = accumulated.trim().length > 0 ? accumulated : t("messageCancelledByUser");
        await this.messageRenderer.renderContent(assistantEl, finalText);
        cc.addMessage("assistant", finalText);
        finalizeThinking();
      } else {
        await this.messageRenderer.renderContent(assistantEl, t("messageNoAssistantOutput"));
        this.appendSystemMessageToPanel(tab.panelEl, tf("messageRequestFailed", { error: message }));
        new Notice(tf("noticeCodexError", { error: message }));
        finalizeThinking();
      }
    } finally {
      this.debugLog("sendCurrentInput:finally", {
        sendSeq,
        running: this.running,
        queueLength: this.messageQueue.length,
      });
      finalizeThinking();
      this.cancelledSendSequences.delete(sendSeq);
      if (sendSeq !== this.sendSequence) {
        return;
      }

      this.running = false;
      this.currentTurnId = null;
      this.tabBar.setStreaming(tab.state.tabId, false);
      this.statusPanel?.setTurnStatus("idle");
      this.statusPanel?.clearFinishedAfterDelay(3000);
      this.updateStatus();
      try {
        this.fileContext?.clear();
        this.imageContext?.clear();
      } catch {
        // Keep message flow intact if context cleanup fails.
      }
      try {
        await this.processQueue();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(tf("noticeProcessQueueFailed", { error: message }));
      }
    }
  }

  private async startNewThread(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.updateStatus();
    try {
      const threadId = await this.plugin.client.newThread();
      const tab = this.tabManager.getActiveTab();
      if (tab) {
        tab.conversationController.setThreadId(threadId);
        this.appendSystemMessageToPanel(tab.panelEl, tf("messageStartedNewThread", { threadId }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const tab = this.tabManager.getActiveTab();
      if (tab) this.appendSystemMessageToPanel(tab.panelEl, tf("messageFailedStartNewThread", { error: message }));
      new Notice(tf("noticeCodexError", { error: message }));
    } finally {
      this.running = false;
      this.updateStatus();
    }
  }

  private async restartEngine(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.updateStatus();
    try {
      await this.plugin.client.restart();
      const tab = this.tabManager.getActiveTab();
      if (tab) this.appendSystemMessageToPanel(tab.panelEl, t("messageRestarted"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const tab = this.tabManager.getActiveTab();
      if (tab) this.appendSystemMessageToPanel(tab.panelEl, tf("messageRestartFailed", { error: message }));
      new Notice(tf("noticeCodexError", { error: message }));
    } finally {
      this.running = false;
      this.updateStatus();
    }
  }

  private toggleHistory(): void {
    this.historyOpen = !this.historyOpen;
    if (this.historyOpen) {
      void this.renderHistoryMenu();
      this.historyMenuEl.style.display = "block";
    } else {
      this.historyMenuEl.style.display = "none";
    }
  }

  private async renderHistoryMenu(): Promise<void> {
    this.historyMenuEl.empty();
    const cc = this.tabManager.getActiveConversationController();
    if (!cc) return;

    const list = await cc.listConversations();
    if (list.length === 0) {
      this.historyMenuEl.createDiv({ cls: "codexidian-history-empty", text: t("historyEmpty") });
      return;
    }

    for (const meta of list) {
      this.renderHistoryItem(meta);
    }
  }

  private renderHistoryItem(meta: ConversationMeta): void {
    const item = this.historyMenuEl.createDiv({ cls: "codexidian-history-item" });
    const titleEl = item.createSpan({ cls: "codexidian-history-title" });
    titleEl.setText(meta.title);
    titleEl.title = `${tf("historyMessageCount", { count: meta.messageCount })}\n${meta.preview}`;

    const actions = item.createDiv({ cls: "codexidian-history-actions" });

    const openBtn = actions.createEl("button", { cls: "codexidian-history-action-btn", text: t("open") });
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.openConversation(meta.id);
      this.toggleHistory();
    });

    const deleteBtn = actions.createEl("button", { cls: "codexidian-history-action-btn delete", text: t("del") });
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.deleteConversation(meta.id);
    });

    item.addEventListener("click", () => {
      void this.openConversation(meta.id);
      this.toggleHistory();
    });
  }

  private async openConversation(id: string): Promise<void> {
    const tab = this.tabManager.getActiveTab();
    if (!tab) return;

    const conv = await tab.conversationController.switchTo(id);
    if (!conv) {
      new Notice(t("noticeFailedLoadConversation"));
      return;
    }

    this.tabManager.setConversationId(tab.state.tabId, id);
    tab.panelEl.empty();

    await this.renderConversationMessages(tab.panelEl, conv.messages);

    if (conv.threadId) {
      this.plugin.client.setThreadId(conv.threadId);
    }

    this.updateStatus();
    tab.panelEl.scrollTop = tab.panelEl.scrollHeight;
  }

  private async deleteConversation(id: string): Promise<void> {
    const cc = this.tabManager.getActiveConversationController();
    if (!cc) return;
    await cc.deleteConversation(id);
    void this.renderHistoryMenu();
  }

  private async renderConversationMessages(panelEl: HTMLElement, messages: ChatMessage[]): Promise<void> {
    for (const msg of messages) {
      if (msg.role === "assistant") {
        const el = this.createMessageEl(panelEl, "assistant", msg.id);
        await this.messageRenderer.renderContent(el, msg.content);
      } else {
        this.appendMessageToPanel(panelEl, msg.role, msg.content, msg.id);
      }
    }
  }

  // --- DOM helpers ---

  private createMessageEl(panelEl: HTMLElement, role: string, messageId?: string): HTMLElement {
    const wrapperEl = panelEl.createDiv({ cls: "codexidian-msg-wrapper" });
    wrapperEl.dataset.msgRole = role;
    if (messageId) {
      wrapperEl.dataset.msgId = messageId;
    }

    const messageEl = wrapperEl.createDiv({ cls: `codexidian-msg codexidian-msg-${role}` });
    if (role === "user" && messageId) {
      this.attachUserMessageActions(wrapperEl, messageId);
    }
    return messageEl;
  }

  private appendMessageToPanel(panelEl: HTMLElement, role: string, text: string, messageId?: string): HTMLElement {
    const el = this.createMessageEl(panelEl, role, messageId);
    el.setText(text);
    panelEl.scrollTop = panelEl.scrollHeight;
    return el;
  }

  private attachUserMessageActions(wrapperEl: HTMLElement, messageId: string): void {
    const actionsEl = wrapperEl.createDiv({ cls: "codexidian-msg-actions" });

    const editBtn = actionsEl.createEl("button", {
      cls: "codexidian-msg-action-btn",
      text: "✏",
      title: t("editMessageTitle"),
    });
    editBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.editMessage(messageId);
    });

    const rewindBtn = actionsEl.createEl("button", {
      cls: "codexidian-msg-action-btn",
      text: "↩",
      title: t("rewindTitle"),
    });
    rewindBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.rewindToMessage(messageId);
    });

    const forkBtn = actionsEl.createEl("button", {
      cls: "codexidian-msg-action-btn",
      text: "⑂",
      title: t("forkTitle"),
    });
    forkBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.forkFromMessage(messageId);
    });
  }

  private async editMessage(messageId: string): Promise<void> {
    if (this.running) {
      new Notice(t("noticeCannotEditRunning"));
      return;
    }

    const tab = this.tabManager.getActiveTab();
    if (!tab) return;

    const wrapperEl = this.getMessageWrapper(tab.panelEl, messageId);
    if (!wrapperEl || wrapperEl.dataset.msgRole !== "user") {
      new Notice(t("noticeCannotEditNotFound"));
      return;
    }
    if (wrapperEl.querySelector(".codexidian-msg-edit-area")) {
      return;
    }

    const messageEl = wrapperEl.querySelector<HTMLElement>(".codexidian-msg-user");
    if (!messageEl) return;

    const originalText = messageEl.textContent ?? "";
    const actionsEl = wrapperEl.querySelector<HTMLElement>(".codexidian-msg-actions");

    messageEl.style.display = "none";
    if (actionsEl) {
      actionsEl.style.display = "none";
    }

    const editWrapEl = wrapperEl.createDiv({ cls: "codexidian-msg-edit-wrap" });
    const editAreaEl = editWrapEl.createEl("textarea", { cls: "codexidian-msg-edit-area" });
    editAreaEl.value = originalText;

    const editActionsEl = editWrapEl.createDiv({ cls: "codexidian-msg-edit-actions" });
    const saveBtn = editActionsEl.createEl("button", {
      cls: "codexidian-msg-edit-save",
      text: t("saveAndResend"),
    });
    const cancelBtn = editActionsEl.createEl("button", {
      cls: "codexidian-msg-edit-cancel",
      text: t("cancel"),
    });

    const restore = () => {
      editWrapEl.remove();
      messageEl.style.display = "";
      if (actionsEl) {
        actionsEl.style.display = "";
      }
    };

    cancelBtn.addEventListener("click", () => {
      restore();
    });

    saveBtn.addEventListener("click", () => {
      void (async () => {
        const editedText = editAreaEl.value.trim();
        if (!editedText) {
          new Notice(t("noticeEditedMessageEmpty"));
          return;
        }

        const confirmed = window.confirm(t("confirmSaveEditResend"));
        if (!confirmed) {
          return;
        }

        saveBtn.disabled = true;
        cancelBtn.disabled = true;

        try {
          const target = await tab.conversationController.truncateAfter(messageId);
          if (!target || target.role !== "user") {
            new Notice(t("noticeEditMessageNotFound"));
            restore();
            return;
          }

          this.removePanelContentFromMessage(tab.panelEl, messageId);

          try {
            const threadId = await this.plugin.client.newThread();
            tab.conversationController.setThreadId(threadId);
            this.appendSystemMessageToPanel(tab.panelEl, t("messageEditedStartedFreshThread"));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.appendSystemMessageToPanel(
              tab.panelEl,
              tf("messageEditedSaveButThreadFail", { error: message }),
            );
          }

          this.inputEl.value = "";
          await this.sendCurrentInput(editedText);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(tf("noticeEditFailed", { error: message }));
          restore();
        }
      })();
    });

    editAreaEl.focus();
    editAreaEl.setSelectionRange(editAreaEl.value.length, editAreaEl.value.length);
  }

  private async applyCodeToNote(code: string, language: string, triggerEl?: HTMLElement): Promise<void> {
    const trimmedCode = code.trimEnd();
    if (!trimmedCode) {
      new Notice(t("noticeNoCodeToApply"));
      return;
    }

    const defaultPath = this.getCurrentMarkdownNotePath() ?? "";
    const targetInput = window.prompt(t("promptTargetNotePath"), defaultPath);
    if (targetInput === null) {
      return;
    }

    const targetPath = normalizePath((targetInput.trim() || defaultPath).trim());
    if (!targetPath) {
      new Notice(t("noticeTargetPathRequired"));
      return;
    }

    const pathValidation = this.getPathValidator().validate(targetPath, "write");
    if (!pathValidation.allowed) {
      new Notice(tf("securityBlocked", { reason: pathValidation.reason ?? t("securityBlockedReasonDefault") }));
      return;
    }

    const mode = await this.pickApplyMode(triggerEl);
    if (!mode) {
      return;
    }

    const modeLabel = mode === "replace-selection" ? t("replaceSelection") : t("appendToNote");
    if (this.plugin.settings.securityRequireApprovalForWrite) {
      const confirmed = window.confirm(tf("confirmApplyCode", { path: targetPath, mode: modeLabel }));
      if (!confirmed) {
        return;
      }
    }

    const maxBytes = this.getMaxNoteSizeBytes();
    try {
      if (mode === "replace-selection") {
        await this.applyCodeReplaceSelection(targetPath, trimmedCode, maxBytes);
      } else {
        await this.applyCodeAppendToNote(targetPath, trimmedCode, language, maxBytes);
      }
      new Notice(tf("noticeAppliedCode", { path: targetPath, mode: modeLabel }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(tf("noticeApplyCodeFailed", { error: message }));
    }
  }

  private async pickApplyMode(triggerEl?: HTMLElement): Promise<"replace-selection" | "append-to-note" | null> {
    const fallbackPick = (): "replace-selection" | "append-to-note" => {
      const replace = window.confirm(t("confirmApplyModeFallback"));
      return replace ? "replace-selection" : "append-to-note";
    };

    if (!triggerEl || !document.body) {
      return fallbackPick();
    }

    document.querySelectorAll(".codexidian-apply-mode-menu").forEach((el) => el.remove());

    return await new Promise<"replace-selection" | "append-to-note" | null>((resolve) => {
      const menuEl = document.createElement("div");
      menuEl.classList.add("codexidian-apply-mode-menu");

      const replaceBtn = document.createElement("button");
      replaceBtn.classList.add("codexidian-apply-mode-option");
      replaceBtn.textContent = t("replaceSelection");

      const appendBtn = document.createElement("button");
      appendBtn.classList.add("codexidian-apply-mode-option");
      appendBtn.textContent = t("appendToNote");

      const cancelBtn = document.createElement("button");
      cancelBtn.classList.add("codexidian-apply-mode-cancel");
      cancelBtn.textContent = t("applyModeCancel");

      menuEl.appendChild(replaceBtn);
      menuEl.appendChild(appendBtn);
      menuEl.appendChild(cancelBtn);
      document.body.appendChild(menuEl);

      const rect = triggerEl.getBoundingClientRect();
      const menuWidth = 210;
      const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));
      const menuHeight = 132;
      const top = Math.max(8, Math.min(window.innerHeight - menuHeight - 8, rect.bottom + 6));
      menuEl.style.left = `${left}px`;
      menuEl.style.top = `${top}px`;

      let settled = false;
      const cleanup = (result: "replace-selection" | "append-to-note" | null) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("mousedown", onOutsideMouseDown, true);
        document.removeEventListener("keydown", onEscape, true);
        menuEl.remove();
        resolve(result);
      };

      const onOutsideMouseDown = (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (menuEl.contains(target) || target === triggerEl) return;
        cleanup(null);
      };

      const onEscape = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        cleanup(null);
      };

      replaceBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        cleanup("replace-selection");
      });

      appendBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        cleanup("append-to-note");
      });

      cancelBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        cleanup(null);
      });

      window.setTimeout(() => {
        document.addEventListener("mousedown", onOutsideMouseDown, true);
        document.addEventListener("keydown", onEscape, true);
      }, 0);
    });
  }

  private async applyCodeReplaceSelection(targetPath: string, code: string, maxBytes: number): Promise<void> {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.file) {
      throw new Error(t("errorNoActiveEditor"));
    }

    const activePath = normalizePath(activeView.file.path);
    const normalizedTarget = normalizePath(targetPath);
    if (activePath !== normalizedTarget) {
      throw new Error(t("errorReplaceSelectionRequiresTarget"));
    }

    const selected = activeView.editor.getSelection();
    if (!selected) {
      throw new Error(t("errorNoSelectionToReplace"));
    }

    const currentText = activeView.editor.getValue();
    const projectedBytes = this.getByteLength(currentText) - this.getByteLength(selected) + this.getByteLength(code);
    if (projectedBytes > maxBytes) {
      throw new Error(tf("errorMaxSizeExceeded", { kb: this.plugin.settings.securityMaxNoteSize }));
    }

    activeView.editor.replaceSelection(code);
  }

  private async applyCodeAppendToNote(
    targetPath: string,
    code: string,
    language: string,
    maxBytes: number,
  ): Promise<void> {
    const normalizedTarget = normalizePath(targetPath);
    const abstractFile = this.app.vault.getAbstractFileByPath(normalizedTarget);
    const fenced = this.formatFencedCode(code, language);

    if (abstractFile instanceof TFile) {
      const current = await this.app.vault.read(abstractFile);
      const separator = current.length === 0 ? "" : (current.endsWith("\n") ? "\n" : "\n\n");
      const nextContent = `${current}${separator}${fenced}\n`;
      if (this.getByteLength(nextContent) > maxBytes) {
        throw new Error(tf("errorMaxSizeExceeded", { kb: this.plugin.settings.securityMaxNoteSize }));
      }
      await this.app.vault.modify(abstractFile, nextContent);
      return;
    }

    if (abstractFile) {
      throw new Error(tf("errorTargetPathNotFile", { path: normalizedTarget }));
    }

    const initialContent = `${fenced}\n`;
    if (this.getByteLength(initialContent) > maxBytes) {
      throw new Error(tf("errorMaxSizeExceeded", { kb: this.plugin.settings.securityMaxNoteSize }));
    }

    await this.app.vault.create(normalizedTarget, initialContent);
  }

  private formatFencedCode(code: string, language: string): string {
    const lang = language.trim().toLowerCase();
    const label = lang && lang !== "text" ? lang : "";
    return `\`\`\`${label}\n${code}\n\`\`\``;
  }

  private getPathValidator(): PathValidator {
    return new PathValidator(this.plugin.settings.securityBlockedPaths);
  }

  private getMaxNoteSizeBytes(): number {
    const kb = Number.isFinite(this.plugin.settings.securityMaxNoteSize)
      ? Math.max(1, Math.round(this.plugin.settings.securityMaxNoteSize))
      : 500;
    return kb * 1024;
  }

  private getByteLength(text: string): number {
    return new TextEncoder().encode(text).length;
  }

  private getMessageWrapper(panelEl: HTMLElement, messageId: string): HTMLElement | null {
    const children = Array.from(panelEl.children);
    for (const child of children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.dataset.msgId === messageId) {
        return child;
      }
    }
    return null;
  }

  private async rewindToMessage(messageId: string): Promise<void> {
    if (this.running) {
      new Notice(t("noticeCannotRewindRunning"));
      return;
    }

    const confirmed = window.confirm(t("confirmRewind"));
    if (!confirmed) {
      return;
    }

    const tab = this.tabManager.getActiveTab();
    if (!tab) return;

    try {
      const target = await tab.conversationController.truncateAfter(messageId);
      if (!target || target.role !== "user") {
        new Notice(t("noticeUnableRewind"));
        return;
      }

      this.removePanelContentFromMessage(tab.panelEl, messageId);
      this.inputEl.value = target.content;
      this.inputEl.focus();

      try {
        const threadId = await this.plugin.client.newThread();
        tab.conversationController.setThreadId(threadId);
        this.appendSystemMessageToPanel(tab.panelEl, t("messageRewindComplete"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.appendSystemMessageToPanel(tab.panelEl, tf("messageRewindThreadFail", { error: message }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(tf("noticeRewindFailed", { error: message }));
    } finally {
      this.updateStatus();
    }
  }

  private async forkFromMessage(messageId: string): Promise<void> {
    if (this.running) {
      new Notice(t("noticeCannotForkRunning"));
      return;
    }

    const currentTabCount = this.tabManager.getAllTabStates().length;
    if (currentTabCount >= this.plugin.settings.maxTabs) {
      new Notice(tf("noticeCannotForkMax", { max: this.plugin.settings.maxTabs }));
      return;
    }

    const sourceTab = this.tabManager.getActiveTab();
    if (!sourceTab) return;

    try {
      const branchMessages = sourceTab.conversationController.getMessagesUpTo(messageId);
      if (branchMessages.length === 0) {
        new Notice(t("noticeUnableFork"));
        return;
      }

      const forkTab = this.tabManager.addTab();
      const forkConv = await forkTab.conversationController.createNew(`Fork ${new Date().toLocaleString()}`);
      this.tabManager.setConversationId(forkTab.state.tabId, forkConv.id);
      forkTab.conversationController.setMessages(branchMessages);

      forkTab.panelEl.empty();
      await this.renderConversationMessages(forkTab.panelEl, branchMessages);

      try {
        const threadId = await this.plugin.client.newThread();
        forkTab.conversationController.setThreadId(threadId);
        this.appendSystemMessageToPanel(forkTab.panelEl, t("messageForkCreated"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.appendSystemMessageToPanel(forkTab.panelEl, tf("messageForkThreadFail", { error: message }));
      }

      this.tabManager.switchTo(forkTab.state.tabId);
      this.updateStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(tf("noticeForkFailed", { error: message }));
    }
  }

  private removePanelContentFromMessage(panelEl: HTMLElement, messageId: string): void {
    const children = Array.from(panelEl.children);
    const startIndex = children.findIndex((child) => (
      child instanceof HTMLElement && child.dataset.msgId === messageId
    ));
    if (startIndex < 0) return;

    for (let index = children.length - 1; index >= startIndex; index--) {
      children[index].remove();
    }
    panelEl.scrollTop = panelEl.scrollHeight;
  }

  private appendSystemMessageToPanel(panelEl: HTMLElement, message: string): void {
    this.appendMessageToPanel(panelEl, "system", message);
  }

  appendSystemMessage(message: string): void {
    const tab = this.tabManager?.getActiveTab();
    if (tab) {
      this.appendSystemMessageToPanel(tab.panelEl, message);
    }
  }

  refreshLocale(): void {
    this.titleEl?.setText(t("appTitle"));
    this.historyBtn?.setText(t("history"));
    this.newThreadBtn?.setText(t("newThread"));
    this.restartBtn?.setText(t("restart"));
    this.inputEl.placeholder = t("askPlaceholder");
    this.modelLabelEl?.setText(t("model"));
    this.effortLabelEl?.setText(t("effort"));
    this.sendHintEl?.setText(t("sendShortcutHint"));
    this.sendBtn?.setText(t("send"));
    this.updateNoteContextToggle();
    this.registerBuiltinSlashCommands();
    if (this.historyOpen) {
      void this.renderHistoryMenu();
    }
    this.statusPanel?.refreshLocale();
    this.updateQueueIndicator();
    this.updateStatus();
  }

  private async collectAttachedFileContents(
    notePath: string | null,
    panelEl: HTMLElement,
  ): Promise<Array<{ path: string; content: string }>> {
    const MAX_FILE_CHARS = 10_000;
    const requestedPaths = new Set<string>();

    for (const path of this.fileContext?.getFiles() ?? []) {
      requestedPaths.add(path);
    }
    if (this.includeCurrentNoteContent && notePath) {
      requestedPaths.add(notePath);
    }

    const fileContents: Array<{ path: string; content: string }> = [];
    for (const path of requestedPaths) {
      const abstractFile = this.app.vault.getAbstractFileByPath(path);
      if (!(abstractFile instanceof TFile)) {
        this.appendSystemMessageToPanel(panelEl, tf("messageContextFileNotFound", { path }));
        continue;
      }

      try {
        let content = await this.app.vault.read(abstractFile);
        if (content.length > MAX_FILE_CHARS) {
          content = `${content.slice(0, MAX_FILE_CHARS)}\n\n...[truncated to ${MAX_FILE_CHARS} characters]`;
        }
        fileContents.push({ path, content });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.appendSystemMessageToPanel(panelEl, tf("messageContextFileReadFailed", { path, error: message }));
      }
    }

    return fileContents;
  }

  private refreshCurrentNoteContext(): void {
    const notePath = this.getCurrentMarkdownNotePath();

    if (!notePath) {
      this.noteContextEl.style.display = "none";
      this.noteContextTextEl.setText("");
      this.noteContextTextEl.title = "";
      this.updateContextRowVisibility();
      return;
    }

    this.noteContextEl.style.display = "flex";
    this.noteContextTextEl.setText(`📝 ${this.getFileName(notePath)}`);
    this.noteContextTextEl.title = notePath;
    this.updateContextRowVisibility();
  }

  private updateNoteContextToggle(): void {
    this.noteContextToggleEl.setText(this.includeCurrentNoteContent ? t("noteToggleOn") : t("noteToggleOff"));
    if (this.includeCurrentNoteContent) {
      this.noteContextToggleEl.addClass("is-enabled");
    } else {
      this.noteContextToggleEl.removeClass("is-enabled");
    }
  }

  private updateContextRowVisibility(): void {
    const hasNote = this.noteContextEl.style.display !== "none";
    const hasSelection = this.selectionContextEl.style.display !== "none";
    this.contextRowEl.style.display = hasNote || hasSelection ? "flex" : "none";
  }

  private getFileName(path: string): string {
    const segments = path.split("/");
    return segments[segments.length - 1] || path;
  }

  private getCurrentMarkdownNotePath(): string | null {
    const activeMdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeMdView?.file?.path) {
      return activeMdView.file.path;
    }

    const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of markdownLeaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path) {
        return view.file.path;
      }
    }

    return null;
  }

  async showApprovalCard(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.statusPanel?.setTurnStatus("waiting_approval");
    const tab = await this.ensureActiveTabForInlineCard();
    if (!tab) {
      this.restoreStatusAfterInteractiveCard();
      return "decline";
    }

    const statusEntryId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.statusPanel?.addEntry({
      id: statusEntryId,
      type: "info",
      label: this.getApprovalTitle(request.type),
      detail: this.truncateStatusDetail(request.command || request.filePath || request.cwd),
      status: "running",
    });

    const cardEl = tab.panelEl.createDiv({ cls: "codexidian-approval-card" });
    const headerEl = cardEl.createDiv({ cls: "codexidian-approval-header" });
    headerEl.createSpan({
      cls: "codexidian-approval-icon",
      text: request.type === "fileChange" || request.type === "applyPatch" ? "📝" : "⚡",
    });
    headerEl.createSpan({ text: this.getApprovalTitle(request.type) });

    const bodyEl = cardEl.createDiv({ cls: "codexidian-approval-body" });
    if (request.command) {
      bodyEl.createEl("code", { text: request.command });
    }
    if (request.filePath) {
      bodyEl.createDiv({ cls: "codexidian-approval-meta", text: tf("approvalMetaFile", { path: request.filePath }) });
    }
    if (request.cwd) {
      bodyEl.createDiv({ cls: "codexidian-approval-meta", text: tf("approvalMetaCwd", { cwd: request.cwd }) });
    }
    if (!request.command && !request.filePath && request.params) {
      bodyEl.createEl("code", {
        text: JSON.stringify(request.params).slice(0, 800),
      });
    }

    const actionsEl = cardEl.createDiv({ cls: "codexidian-approval-actions" });
    const approveBtn = actionsEl.createEl("button", {
      cls: "codexidian-approval-btn approve",
      text: t("approve"),
    });
    const denyBtn = actionsEl.createEl("button", {
      cls: "codexidian-approval-btn deny",
      text: t("deny"),
    });
    const statusEl = cardEl.createDiv({ cls: "codexidian-approval-status" });

    tab.panelEl.scrollTop = tab.panelEl.scrollHeight;

    return await new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        settle("decline", t("approvalTimedOut"));
      }, 60_000);

      const settle = (decision: ApprovalDecision, statusText: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);

        approveBtn.disabled = true;
        denyBtn.disabled = true;
        cardEl.addClass("codexidian-approval-card-readonly");
        cardEl.addClass(decision === "accept" ? "codexidian-approval-accepted" : "codexidian-approval-denied");
        statusEl.setText(tf("approvalDecisionPrefix", { status: statusText }));
        this.statusPanel?.updateEntry(statusEntryId, {
          status: decision === "accept" ? "completed" : "failed",
        });
        this.restoreStatusAfterInteractiveCard();
        resolve(decision);
      };

      approveBtn.addEventListener("click", () => settle("accept", t("approvalApproved")));
      denyBtn.addEventListener("click", () => settle("decline", t("approvalDenied")));
    });
  }

  async showUserInputCard(request: UserInputRequest): Promise<UserInputResponse> {
    this.statusPanel?.setTurnStatus("waiting_approval");
    const tab = await this.ensureActiveTabForInlineCard();
    if (!tab) {
      this.restoreStatusAfterInteractiveCard();
      return this.buildDefaultUserInputResponse(request);
    }

    const statusEntryId = `input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.statusPanel?.addEntry({
      id: statusEntryId,
      type: "info",
      label: t("statusUserInputRequest"),
      detail: this.truncateStatusDetail(request.questions.map((question) => question.id).join(", ")),
      status: "running",
    });

    const cardEl = tab.panelEl.createDiv({ cls: "codexidian-user-input-card" });
    const headerEl = cardEl.createDiv({ cls: "codexidian-user-input-header" });
    headerEl.createSpan({ text: t("userInputRequest") });

    const states = new Map<string, {
      selected: string | null;
      inputEl: HTMLInputElement;
      optionButtons: HTMLButtonElement[];
      firstOption: string;
    }>();

    for (const question of request.questions) {
      const questionEl = cardEl.createDiv({ cls: "codexidian-user-input-question" });
      questionEl.createDiv({
        cls: "codexidian-user-input-text",
        text: question.text || question.id,
      });

      const optionsEl = questionEl.createDiv({ cls: "codexidian-user-input-options" });
      const optionButtons: HTMLButtonElement[] = [];
      let firstOption = "";

      for (const option of question.options ?? []) {
        if (!firstOption) firstOption = option.label;
        const optionBtn = optionsEl.createEl("button", {
          cls: "codexidian-user-input-option",
          text: option.label,
        });
        optionButtons.push(optionBtn);
      }

      const inputEl = questionEl.createEl("input", {
        cls: "codexidian-user-input-freeform",
        type: "text",
        placeholder: t("userInputPlaceholder"),
      });

      const state = { selected: null as string | null, inputEl, optionButtons, firstOption };
      states.set(question.id, state);

      for (const optionBtn of optionButtons) {
        optionBtn.addEventListener("click", () => {
          state.selected = optionBtn.textContent ?? "";
          for (const button of optionButtons) {
            if (button === optionBtn) {
              button.addClass("is-selected");
            } else {
              button.removeClass("is-selected");
            }
          }
        });
      }
    }

    const actionsEl = cardEl.createDiv({ cls: "codexidian-user-input-actions" });
    const submitBtn = actionsEl.createEl("button", {
      cls: "codexidian-user-input-submit",
      text: t("submit"),
    });
    const statusEl = cardEl.createDiv({ cls: "codexidian-user-input-status" });

    const resolveResponse = (useDefaults: boolean): UserInputResponse => {
      if (useDefaults) {
        return this.buildDefaultUserInputResponse(request);
      }
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of request.questions) {
        const state = states.get(question.id);
        const custom = state?.inputEl.value.trim() ?? "";
        const selected = state?.selected ?? "";
        const fallback = state?.firstOption ?? "";
        const answer = custom || selected || fallback;
        answers[question.id] = { answers: [answer] };
      }
      return { answers };
    };

    tab.panelEl.scrollTop = tab.panelEl.scrollHeight;

    return await new Promise<UserInputResponse>((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        settle(resolveResponse(true), t("userInputTimedOutDefault"), true);
      }, 60_000);

      const settle = (response: UserInputResponse, statusText: string, failed = false) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);

        submitBtn.disabled = true;
        for (const state of states.values()) {
          state.inputEl.disabled = true;
          for (const button of state.optionButtons) {
            button.disabled = true;
          }
        }
        cardEl.addClass("codexidian-user-input-card-readonly");
        statusEl.setText(statusText);
        this.statusPanel?.updateEntry(statusEntryId, {
          status: failed ? "failed" : "completed",
        });
        this.restoreStatusAfterInteractiveCard();
        resolve(response);
      };

      submitBtn.addEventListener("click", () => {
        settle(resolveResponse(false), t("userInputSubmitted"), false);
      });
    });
  }

  updateStatus(): void {
    const settings = this.plugin.settings;
    const threadId = this.plugin.client.getThreadId();
    const connected = this.plugin.client.isRunning();
    const engineText = connected ? t("connected") : t("disconnected");
    const runningText = this.running ? t("running") : t("idle");
    const threadText = threadId ? `${t("thread")} ${threadId.slice(0, 8)}...` : t("noThread");
    this.statusEl.setText(
      `${engineText} | ${runningText} | ${threadText} | ${settings.model || t("defaultModel")} | ${settings.thinkingEffort} | ${settings.approvalPolicy}`,
    );
    this.restartBtn?.setText(connected ? t("restart") : t("reconnect"));
    this.sendBtn.disabled = false;
    this.inputEl.disabled = false;
    this.newThreadBtn.disabled = this.running;
    this.restartBtn.disabled = this.running;
    this.updateQueueIndicator();
  }

  private isValidTabManagerState(state: unknown): state is TabManagerState {
    if (!state || typeof state !== "object") return false;
    const candidate = state as Partial<TabManagerState> & { openTabs?: unknown[] };
    if (!Array.isArray(candidate.openTabs)) return false;
    if (candidate.activeTabId !== null && candidate.activeTabId !== undefined && typeof candidate.activeTabId !== "string") {
      return false;
    }
    return candidate.openTabs.every((tab) => (
      tab
      && typeof tab === "object"
      && typeof (tab as any).tabId === "string"
      && (((tab as any).conversationId === null) || typeof (tab as any).conversationId === "string")
    ));
  }

  private async restoreTabsWithFallback(): Promise<void> {
    const savedState = (this.plugin.settings as any)._tabManagerState as unknown;
    const attemptedRestore = this.isValidTabManagerState(savedState);

    if (attemptedRestore) {
      try {
        await this.tabManager.restoreState(savedState);
        for (const tabState of this.tabManager.getAllTabStates()) {
          if (!tabState.conversationId) continue;
          const tab = this.tabManager.getTab(tabState.tabId);
          if (tab) {
            await this.restoreTabConversation(tab);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(tf("noticeRestoreTabsFailed", { error: message }));
      }
    }

    if (!this.tabManager.getActiveTab()) {
      const firstState = this.tabManager.getAllTabStates()[0];
      if (firstState) {
        this.tabManager.switchTo(firstState.tabId);
      }
    }

    if (!this.tabManager.getActiveTab()) {
      await this.createNewTab();
    }
  }

  private async ensureActiveTabForInlineCard(): Promise<Tab | null> {
    if (!this.tabManager) return null;

    let tab = this.tabManager.getActiveTab();
    if (!tab) {
      await this.createNewTab();
      tab = this.tabManager.getActiveTab();
    }
    return tab ?? null;
  }

  private buildDefaultUserInputResponse(request: UserInputRequest): UserInputResponse {
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of request.questions) {
      const firstOption = question.options && question.options.length > 0 ? question.options[0].label : "";
      answers[question.id] = { answers: [firstOption] };
    }
    return { answers };
  }

  private getApprovalTitle(type: ApprovalRequest["type"]): string {
    if (type === "commandExecution" || type === "execCommand") {
      return t("approvalTitleCommand");
    }
    if (type === "fileChange" || type === "applyPatch") {
      return t("approvalTitleFile");
    }
    return t("approvalTitleGeneric");
  }

  private resolveEntryStatus(status: string): "completed" | "failed" {
    const normalized = status.trim().toLowerCase();
    if (
      normalized.includes("error")
      || normalized.includes("fail")
      || normalized.includes("deny")
      || normalized.includes("reject")
      || normalized.includes("cancel")
      || normalized.includes("interrupt")
    ) {
      return "failed";
    }
    return "completed";
  }

  private truncateStatusDetail(value?: string): string | undefined {
    if (!value) return undefined;
    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact) return undefined;
    if (compact.length <= 80) return compact;
    return `${compact.slice(0, 80)}...`;
  }

  private isThreadNotFoundMessage(message: string): boolean {
    return message.toLowerCase().includes("thread not found");
  }

  private restoreStatusAfterInteractiveCard(): void {
    if (!this.statusPanel) return;
    if (this.running) {
      this.statusPanel.setTurnStatus("tool_calling");
      return;
    }
    this.statusPanel.setTurnStatus("idle");
    this.statusPanel.clearFinishedAfterDelay(3000);
  }

  private debugLog(event: string, payload?: unknown): void {
    if (payload === undefined) {
      console.log(`[CODEXIDIAN DEBUG] ${event}`);
      return;
    }
    console.log(`[CODEXIDIAN DEBUG] ${event} ${this.stringifyDebug(payload)}`);
  }

  private debugError(event: string, error: unknown, extra?: Record<string, unknown>): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? "") : "";
    const payload = {
      ...(extra ?? {}),
      message,
      stack,
    };
    console.error(`[CODEXIDIAN DEBUG] ${event} ${this.stringifyDebug(payload)}`);
  }

  private stringifyDebug(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}
