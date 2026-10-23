export function createChannelController({
  refs,
  agentClient,
  getRuntimeState,
  getConversation,
  updateConversation,
  refresh,
}) {
  const NEW_CHANNEL = "__new__";
  let channels = [];
  let activeChannelId = "";
  let editingChannelId = "";
  let editorDirty = false;
  let modelSignature = "";
  let applyingSettings = false;

  const channelById = (id) =>
    channels.find((channel) => channel.id === id) || null;
  const activeChannel = () =>
    channelById(activeChannelId) || channels[0] || null;

  function nextCustomId() {
    const numbers = channels
      .map((channel) => channel.id)
      .filter((id) => /^custom-\d+$/.test(id))
      .map((id) => Number.parseInt(id.slice("custom-".length), 10));
    return `custom-${numbers.length ? Math.max(...numbers) + 1 : 1}`;
  }

  function fillSelect(select, extra) {
    const signature =
      channels.map((channel) => `${channel.id}:${channel.label}`).join("|") +
      (extra ? `|${extra.value}` : "");
    if (select.dataset.signature === signature) return;
    select.dataset.signature = signature;
    select.replaceChildren();
    for (const channel of channels)
      select.append(new Option(channel.label || channel.id, channel.id));
    if (extra) select.append(new Option(extra.label, extra.value));
  }

  function updateSetupHint() {
    const channel = channelById(refs.setupChannelInput.value);
    refs.setupChannelHint.textContent = channel?.baseURL
      ? `接口：${channel.baseURL}`
      : "";
    refs.apiKeyInput.placeholder = channel?.hasKey
      ? "已配置，留空则不变"
      : "粘贴 API Key";
  }

  function syncEditor(id) {
    const channel =
      id === NEW_CHANNEL ? null : channelById(id) || activeChannel();
    const builtin = Boolean(channel?.builtin);
    refs.channelLabelInput.value = channel?.label || "自定义渠道";
    refs.channelLabelInput.disabled = builtin;
    refs.channelBaseURLInput.value = channel?.baseURL || "";
    refs.channelBaseURLInput.disabled = Boolean(
      channel?.builtin && !channel.endpointEditable,
    );
    refs.channelApiInput.value = channel?.api || "openai-completions";
    refs.channelApiInput.disabled = builtin;
    refs.channelKeyInput.value = "";
    refs.channelKeyInput.placeholder = channel?.hasKey
      ? "已保存，留空则不变"
      : "粘贴该渠道的 Key";
    refs.channelModelInput.value =
      channel?.models?.map((model) => model.id).join(", ") || "";
    refs.channelModelInput.disabled = builtin;
    refs.channelReasoningInput.checked = Boolean(channel?.reasoning);
    refs.channelReasoningInput.disabled = builtin;
    refs.deleteChannel.disabled = builtin;
    refs.channelSelect.value = id;
  }

  function renderSelects() {
    fillSelect(refs.channelInput);
    fillSelect(refs.channelQuickInput);
    refs.channelInput.value = channelById(activeChannelId)
      ? activeChannelId
      : "";
    const setupPrevious = refs.setupChannelInput.value;
    fillSelect(refs.setupChannelInput);
    refs.setupChannelInput.value = channelById(setupPrevious)
      ? setupPrevious
      : activeChannelId;
    if (refs.channelQuickInput)
      refs.channelQuickInput.value = activeChannelId || "";
    fillSelect(refs.channelSelect, {
      label: "新建自定义渠道",
      value: NEW_CHANNEL,
    });
    refs.channelSelect.value = channelById(editingChannelId || activeChannelId)
      ? editingChannelId || activeChannelId
      : activeChannelId;
    updateSetupHint();
    if (!editorDirty) syncEditor(refs.channelSelect.value);
  }

  function populateModelSelect(health) {
    const channel = channelById(health.channel);
    const models = channel?.models?.length
      ? channel.models
      : health.model
        ? [{ id: health.model, name: health.model }]
        : [];
    const signature = `${models.map((model) => model.id).join(",")}|${health.model}`;
    if (signature !== modelSignature) {
      modelSignature = signature;
      for (const select of [refs.modelInput, refs.modelQuickInput]) {
        if (!select) continue;
        select.replaceChildren();
        for (const model of models)
          select.append(new Option(model.name || model.id, model.id));
        if (health.model && !models.some((model) => model.id === health.model))
          select.append(new Option(health.model, health.model));
      }
    }
    if (document.activeElement !== refs.modelInput)
      refs.modelInput.value = health.model || "";
    if (refs.modelQuickInput && document.activeElement !== refs.modelQuickInput)
      refs.modelQuickInput.value = health.model || "";
    const reasoning = channel ? Boolean(channel.reasoning) : true;
    refs.effortInput.disabled = !reasoning;
    if (refs.effortQuickInput) refs.effortQuickInput.disabled = !reasoning;
    refs.effortInput.title = reasoning ? "" : "该模型不支持推理强度";
    if (document.activeElement !== refs.effortInput)
      refs.effortInput.value = health.reasoningEffort || "low";
    if (
      refs.effortQuickInput &&
      document.activeElement !== refs.effortQuickInput
    )
      refs.effortQuickInput.value = health.reasoningEffort || "low";
  }

  async function configure(patch, busyText) {
    if (getRuntimeState() === "thinking") {
      refs.quickStatus.textContent = "任务执行中，稍后再切换";
      return false;
    }
    applyingSettings = true;
    if (busyText) refs.quickStatus.textContent = busyText;
    try {
      await agentClient.configure(patch);
      return true;
    } catch (error) {
      refs.quickStatus.textContent = `切换失败：${error.message}`;
      return false;
    } finally {
      applyingSettings = false;
      await refresh();
    }
  }

  async function applyQuickSettings() {
    const conversation = getConversation?.();
    const model = refs.modelQuickInput?.value || refs.modelInput.value;
    const reasoningEffort =
      refs.effortQuickInput?.value || refs.effortInput.value;
    if (conversation) {
      const saved = await updateConversation({
        model,
        reasoningEffort,
      });
      refs.quickStatus.textContent = saved ? "已应用到当前对话" : "应用失败";
      return;
    }
    if (
      await configure(
        {
          model,
          reasoningEffort,
        },
        "正在应用…",
      )
    )
      refs.quickStatus.textContent = "已设为新对话默认值";
  }

  async function switchChannel(id) {
    if (!id || id === activeChannelId) return;
    const conversation = getConversation?.();
    const selected = channelById(id);
    if (conversation && selected) {
      const saved = await updateConversation({
        channel: id,
        model: selected.model,
        reasoningEffort: selected.reasoningEffort,
      });
      if (saved) {
        activeChannelId = id;
        refs.quickStatus.textContent = "已切换当前对话渠道";
        await refresh();
      }
      return;
    }
    if (await configure({ activeChannel: id }, "正在切换渠道…"))
      refs.quickStatus.textContent = "已设为新对话默认渠道";
  }

  async function saveChannel() {
    const creating = refs.channelSelect.value === NEW_CHANNEL;
    const id = creating ? nextCustomId() : refs.channelSelect.value;
    const patch = { id, reasoning: refs.channelReasoningInput.checked };
    if (refs.channelLabelInput.value.trim())
      patch.label = refs.channelLabelInput.value.trim();
    if (refs.channelBaseURLInput.value.trim())
      patch.baseURL = refs.channelBaseURLInput.value.trim();
    if (!refs.channelApiInput.disabled) patch.api = refs.channelApiInput.value;
    if (refs.channelKeyInput.value.trim())
      patch.apiKey = refs.channelKeyInput.value.trim();
    if (!refs.channelModelInput.disabled) {
      const models = refs.channelModelInput.value
        .split(/[,\s]+/)
        .filter(Boolean);
      if (models.length) Object.assign(patch, { models, model: models[0] });
    }
    refs.saveChannel.disabled = true;
    refs.channelStatus.textContent = "正在保存…";
    applyingSettings = true;
    try {
      await agentClient.configure({
        channelPatch: patch,
        ...(creating ? { activeChannel: id } : {}),
      });
      editingChannelId = id;
      editorDirty = false;
      refs.channelStatus.textContent = "已保存，将在各对话下次运行时应用。";
    } catch (error) {
      refs.channelStatus.textContent = `保存失败：${error.message}`;
    } finally {
      applyingSettings = false;
      refs.saveChannel.disabled = false;
      await refresh();
    }
  }

  async function deleteChannel() {
    const id = refs.channelSelect.value;
    if (channelById(id)?.builtin) {
      refs.channelStatus.textContent = "内置渠道不能删除";
      return;
    }
    applyingSettings = true;
    try {
      await agentClient.configure({ removeChannel: id });
      editingChannelId = "";
      editorDirty = false;
      refs.channelStatus.textContent = "已删除。";
    } catch (error) {
      refs.channelStatus.textContent = `删除失败：${error.message}`;
    } finally {
      applyingSettings = false;
      await refresh();
    }
  }

  function init() {
    refs.channelInput.addEventListener("change", () =>
      switchChannel(refs.channelInput.value),
    );
    refs.channelQuickInput?.addEventListener("change", () =>
      switchChannel(refs.channelQuickInput.value),
    );
    refs.setupChannelInput.addEventListener("change", updateSetupHint);
    refs.modelInput.addEventListener("change", applyQuickSettings);
    refs.effortInput.addEventListener("change", applyQuickSettings);
    refs.modelQuickInput?.addEventListener("change", applyQuickSettings);
    refs.effortQuickInput?.addEventListener("change", applyQuickSettings);
    refs.channelSelect.addEventListener("change", () => {
      editingChannelId = refs.channelSelect.value;
      editorDirty = false;
      syncEditor(editingChannelId);
      refs.channelStatus.textContent = "";
    });
    for (const input of [
      refs.channelLabelInput,
      refs.channelBaseURLInput,
      refs.channelKeyInput,
      refs.channelModelInput,
    ])
      input.addEventListener("input", () => {
        editorDirty = true;
      });
    refs.channelApiInput.addEventListener("change", () => {
      editorDirty = true;
    });
    refs.channelReasoningInput.addEventListener("change", () => {
      editorDirty = true;
    });
    refs.saveChannel.addEventListener("click", saveChannel);
    refs.newChannel.addEventListener("click", () => {
      editingChannelId = NEW_CHANNEL;
      editorDirty = false;
      syncEditor(NEW_CHANNEL);
    });
    refs.deleteChannel.addEventListener("click", deleteChannel);
  }

  return {
    init,
    update(health) {
      channels = Array.isArray(health.channels) ? health.channels : [];
      activeChannelId = health.channel || "";
      renderSelects();
      if (!applyingSettings) populateModelSelect(health);
    },
    channelById,
    activeChannel,
    get applyingSettings() {
      return applyingSettings;
    },
  };
}
