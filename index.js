// 剧情规划大师 - 聊天优化插件
// 由Cline移植并重构

import { callInterceptionApi } from './api.js';
import { getCombinedWorldbookContent } from './lore.js';
import { createDrawer } from './ui/drawer.js';
import { defaultSettings } from './utils/settings.js';
import { extractContentByTag, replaceContentByTag, extractFullTagBlock, extractAllTags } from './utils/tagProcessor.js';
import { characters, eventSource, event_types, getRequestHeaders, saveSettings, this_chid } from '/script.js';
import { extension_settings, getContext } from '/scripts/extensions.js';

const extension_name = 'quick-response-force';
let isProcessing = false;
let tempPlotToSave = null; // [架构重构] 用于在生成和消息创建之间临时存储plot

/**
 * 将从 st-memory-enhancement 获取的原始表格JSON数据转换为更适合LLM读取的文本格式。
 * @param {object} jsonData - ext_exportAllTablesAsJson 返回的JSON对象。
 * @returns {string} - 格式化后的文本字符串。
 */
function formatTableDataForLLM(jsonData) {
  if (!jsonData || typeof jsonData !== 'object' || Object.keys(jsonData).length === 0) {
    return '当前无任何可用的表格数据。';
  }

  let output = '以下是当前角色聊天记录中，由st-memory-enhancement插件保存的全部表格数据：\n';

  for (const sheetId in jsonData) {
    if (Object.prototype.hasOwnProperty.call(jsonData, sheetId)) {
      const sheet = jsonData[sheetId];
      // 确保表格有名称，且内容至少包含表头和一行数据
      if (sheet && sheet.name && sheet.content && sheet.content.length > 1) {
        output += `\n## 表格: ${sheet.name}\n`;
        const headers = sheet.content[0].slice(1); // 第一行是表头，第一个元素通常为空
        const rows = sheet.content.slice(1);

        rows.forEach((row, rowIndex) => {
          const rowData = row.slice(1);
          let rowOutput = '';
          let hasContent = false;
          headers.forEach((header, index) => {
            const cellValue = rowData[index];
            if (cellValue !== null && cellValue !== undefined && String(cellValue).trim() !== '') {
              rowOutput += `  - ${header}: ${cellValue}\n`;
              hasContent = true;
            }
          });

          if (hasContent) {
            output += `\n### ${sheet.name} - 第 ${rowIndex + 1} 条记录\n${rowOutput}`;
          }
        });
      }
    }
  }
  output += '\n--- 表格数据结束 ---\n';
  return output;
}

/**
 * [新增] 转义正则表达式特殊字符。
 * @param {string} string - 需要转义的字符串.
 * @returns {string} - 转义后的字符串.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& 表示匹配到的整个字符串
}

/**
 * [新增] 加载上次使用的预设到全局设置，并清除当前角色卡上冲突的陈旧设置。
 * 这是为了确保在切换角色或新开对话时，预设能够被正确应用，而不是被角色卡上的“幽灵数据”覆盖。
 */
async function loadPresetAndCleanCharacterData() {
  const settings = extension_settings[extension_name];
  if (!settings) return;

  const lastUsedPresetName = settings.lastUsedPresetName;
  const presets = settings.promptPresets || [];

  if (lastUsedPresetName && presets.length > 0) {
    const presetToLoad = presets.find(p => p.name === lastUsedPresetName);
    if (presetToLoad) {
      console.log(`[${extension_name}] Applying last used preset: "${lastUsedPresetName}"`);

      // 步骤1: 将预设内容加载到全局设置中
      // [架构重构] 支持新旧格式预设
      const newApiSettings = {};

      // 迁移基本速率设置
      if (presetToLoad.rateMain !== undefined) newApiSettings.rateMain = presetToLoad.rateMain;
      if (presetToLoad.ratePersonal !== undefined) newApiSettings.ratePersonal = presetToLoad.ratePersonal;
      if (presetToLoad.rateErotic !== undefined) newApiSettings.rateErotic = presetToLoad.rateErotic;
      if (presetToLoad.rateCuckold !== undefined) newApiSettings.rateCuckold = presetToLoad.rateCuckold;

      // 迁移提示词
      if (presetToLoad.prompts && Array.isArray(presetToLoad.prompts)) {
        newApiSettings.prompts = JSON.parse(JSON.stringify(presetToLoad.prompts));
      } else {
        // [新功能] 旧预设兼容：使用默认的新提示词组，并仅覆盖三个基础提示词的内容
        newApiSettings.prompts = JSON.parse(JSON.stringify(defaultSettings.apiSettings.prompts));

        const legacyContentMap = {
          mainPrompt: presetToLoad.mainPrompt,
          systemPrompt: presetToLoad.systemPrompt,
          finalSystemDirective: presetToLoad.finalSystemDirective,
        };

        newApiSettings.prompts.forEach(p => {
          if (legacyContentMap[p.id] !== undefined) {
            p.content = legacyContentMap[p.id] || '';
          }
        });
      }

      Object.assign(settings.apiSettings, newApiSettings);

      // 步骤2: 清除当前角色卡上的陈旧提示词数据
      const character = characters[this_chid];
      if (character?.data?.extensions?.[extension_name]?.apiSettings) {
        const charApiSettings = character.data.extensions[extension_name].apiSettings;
        const keysToClear = [
          'mainPrompt',
          'systemPrompt',
          'finalSystemDirective',
          'prompts', // 清除角色卡上的 prompts，优先使用全局/预设
          'rateMain',
          'ratePersonal',
          'rateErotic',
          'rateCuckold',
        ];
        let settingsCleared = false;
        keysToClear.forEach(key => {
          if (charApiSettings[key] !== undefined) {
            delete charApiSettings[key];
            settingsCleared = true;
          }
        });

        if (settingsCleared) {
          console.log(
            `[${extension_name}] Cleared stale prompt data from character card to ensure preset is applied. Saving...`,
          );
          // [最终修复] 必须等待保存操作完成，以避免竞争条件
          try {
            const response = await fetch('/api/characters/merge-attributes', {
              method: 'POST',
              headers: getRequestHeaders(),
              body: JSON.stringify({
                avatar: character.avatar,
                data: { extensions: { [extension_name]: { apiSettings: charApiSettings } } },
              }),
            });
            if (!response.ok) {
              throw new Error(`API call failed with status: ${response.status}`);
            }
            console.log(`[${extension_name}] Character card updated successfully.`);
          } catch (error) {
            console.error(`[${extension_name}] Failed to clear stale character settings on chat change:`, error);
          }
        }
      }
    }
  }

  // [最终修复] 立即将加载了预设的全局设置保存到磁盘，防止在程序重载时被旧的磁盘数据覆盖。
  saveSettings();
  console.log(`[${extension_name}] Global settings persisted to disk after applying preset.`);
}

/**
 * [架构重构] 从聊天记录中反向查找最新的plot。
 * @returns {string} - 返回找到的plot文本，否则返回空字符串。
 */
function getPlotFromHistory() {
  const context = getContext();
  if (!context || !context.chat || context.chat.length === 0) {
    return '';
  }

  // 从后往前遍历查找
  for (let i = context.chat.length - 1; i >= 0; i--) {
    const message = context.chat[i];
    if (message.qrf_plot) {
      console.log(`[${extension_name}] Found plot in message ${i}`);
      return message.qrf_plot;
    }
  }
  return '';
}

/**
 * [架构重构] 将plot附加到最新的AI消息上。
 */
async function savePlotToLatestMessage() {
  if (tempPlotToSave) {
    const context = getContext();
    // 在SillyTavern的事件触发时，chat数组应该已经更新
    if (context.chat.length > 0) {
      const lastMessage = context.chat[context.chat.length - 1];
      // 确保是AI消息，然后覆盖或附加plot数据
      if (lastMessage && !lastMessage.is_user) {
        lastMessage.qrf_plot = tempPlotToSave;
        console.log(`[${extension_name}] Plot data attached/overwritten on the latest AI message.`);
        // SillyTavern should handle saving automatically after generation ends.
      }
    }
    // 无论成功或失败，都清空临时变量，避免污染下一次生成
    tempPlotToSave = null;
  }
}

/**
 * [重构] 核心优化逻辑，可被多处调用。
 * @param {string} userMessage - 需要被优化的用户输入文本。
 * @returns {Promise<string|null>} - 返回优化后的完整消息体，如果失败或跳过则返回null。
 */
async function runOptimizationLogic(userMessage) {
  // [功能更新] 触发插件时，发射一个事件，以便UI可以按需刷新
  eventSource.emit('qrf-plugin-triggered');

  let $toast = null;
  try {
    // 在每次执行前，都重新进行一次深度合并，以获取最新、最完整的设置状态
    const currentSettings = extension_settings[extension_name] || {};
    // 确保 prompts 数组存在
    const baseApiSettings = { ...defaultSettings.apiSettings, ...currentSettings.apiSettings };
    if (!baseApiSettings.prompts || baseApiSettings.prompts.length === 0) {
      baseApiSettings.prompts = JSON.parse(JSON.stringify(defaultSettings.apiSettings.prompts));
    }

    const settings = {
      ...defaultSettings,
      ...currentSettings,
      apiSettings: baseApiSettings,
    };

    if (!settings.enabled || (settings.apiSettings.apiMode !== 'tavern' && !settings.apiSettings.apiUrl)) {
      return null; // 插件未启用，直接返回
    }

    $toast = toastr.info('正在规划剧情...', '剧情规划大师', { timeOut: 0, extendedTimeOut: 0 });

    const context = getContext();
    const character = characters[this_chid];
    const characterSettings = character?.data?.extensions?.[extension_name]?.apiSettings || {};
    let apiSettings = { ...settings.apiSettings, ...characterSettings };

    // [最终修复] 检查是否有激活的预设。如果有，则强制使用预设的提示词，覆盖任何来自角色卡的“幽灵数据”。
    const lastUsedPresetName = settings.lastUsedPresetName;
    const presets = settings.promptPresets || [];
    if (lastUsedPresetName && presets.length > 0) {
      const presetToApply = presets.find(p => p.name === lastUsedPresetName);
      if (presetToApply) {
        console.log(`[${extension_name}] Active preset "${lastUsedPresetName}" found. Forcing prompt override.`);
        // 处理预设数据迁移
        let presetPrompts = [];
        if (presetToApply.prompts && Array.isArray(presetToApply.prompts)) {
          presetPrompts = JSON.parse(JSON.stringify(presetToApply.prompts));
        } else {
          // [新功能] 旧预设兼容：使用默认的新提示词组，并仅覆盖三个基础提示词的内容
          presetPrompts = JSON.parse(JSON.stringify(defaultSettings.apiSettings.prompts));

          const legacyContentMap = {
            mainPrompt: presetToApply.mainPrompt,
            systemPrompt: presetToApply.systemPrompt,
            finalSystemDirective: presetToApply.finalSystemDirective,
          };

          presetPrompts.forEach(p => {
            if (legacyContentMap[p.id] !== undefined) {
              p.content = legacyContentMap[p.id] || '';
            }
          });
        }

        apiSettings = {
          ...apiSettings,
          prompts: presetPrompts,
          rateMain: presetToApply.rateMain,
          ratePersonal: presetToApply.ratePersonal,
          rateErotic: presetToApply.rateErotic,
          rateCuckold: presetToApply.rateCuckold,
        };
      }
    }

    const contextTurnCount = apiSettings.contextTurnCount ?? 1;
    let slicedContext = [];
    if (contextTurnCount > 0) {
      // [修复] 修正上下文逻辑，确保只包含AI的回复，且数量由`contextTurnCount`控制。
      // 1. 从整个聊天记录中筛选出所有AI的回复。
      const aiHistory = context.chat.filter(msg => !msg.is_user);
      // 2. 从筛选后的历史中，截取最后N条AI的回复。
      const slicedAiHistory = aiHistory.slice(-contextTurnCount);

      slicedContext = slicedAiHistory.map(msg => ({ role: 'assistant', content: msg.mes }));
    }

    let worldbookContent = '';
    if (apiSettings.worldbookEnabled) {
      worldbookContent = await getCombinedWorldbookContent(context, apiSettings, userMessage);
    }

    // [架构重构] 读取上一轮优化结果，用于$6占位符
    const lastPlotContent = getPlotFromHistory();

    let tableDataContent = '';
    try {
      if (window.stMemoryEnhancement && typeof window.stMemoryEnhancement.ext_exportAllTablesAsJson === 'function') {
        const tableDataJson = window.stMemoryEnhancement.ext_exportAllTablesAsJson();
        tableDataContent = formatTableDataForLLM(tableDataJson);
      } else {
        tableDataContent = '依赖的“记忆增强”插件未加载或版本不兼容。';
      }
    } catch (error) {
      console.error(`[${extension_name}] 处理记忆增强插件数据时出错:`, error);
      tableDataContent = '{"error": "加载表格数据时发生错误"}';
    }

    const replacements = {
      sulv1: apiSettings.rateMain,
      sulv2: apiSettings.ratePersonal,
      sulv3: apiSettings.rateErotic,
      sulv4: apiSettings.rateCuckold,
      $5: tableDataContent,
      $6: lastPlotContent, // [新增] 添加$6占位符及其内容
    };

    // 辅助函数：替换文本中的占位符
    const performReplacements = text => {
      if (!text) return '';
      let processed = text;

      // 替换 $1 (Worldbook)
      const worldbookReplacement =
        apiSettings.worldbookEnabled && worldbookContent
          ? `\n<worldbook_context>\n${worldbookContent}\n</worldbook_context>\n`
          : '';
      processed = processed.replace(/(?<!\\)\$1/g, worldbookReplacement);

      // 替换其他
      for (const key in replacements) {
        const value = replacements[key];
        const regex = new RegExp(escapeRegExp(key), 'g');
        processed = processed.replace(regex, value);
      }
      return processed;
    };

    // 构建 API 消息列表
    const messages = [];
    let finalSystemDirectiveContent =
      '[SYSTEM_DIRECTIVE: You are a storyteller. The following <plot> block is your absolute script for this turn. You MUST follow the <directive> within it to generate the story.]';


    const finalApiSettings = { ...apiSettings, extractTags: apiSettings.extractTags, extractTagsFromInput: apiSettings.extractTagsFromInput };
    let fullHistory = [];
    if (slicedContext && Array.isArray(slicedContext)) {
      fullHistory = [...slicedContext];
    }
    if (userMessage) {
      fullHistory.push({ role: 'user', content: userMessage });
    }
    // [新功能] 从历史记录中提取标签
    const tagsToExtractFromInput = (finalApiSettings.extractTagsFromInput || '').trim();
    if (tagsToExtractFromInput) {
        const tagNames = tagsToExtractFromInput.split(',').map(t => t.trim()).filter(t => t);

        // 提取所有匹配的标签内容
        const extractedContents = [];
        fullHistory.forEach(msg => {
            tagNames.forEach(tagName => {
                const matches = extractAllTags(msg.content, tagName);
                if (matches && matches.length > 0) {
                    // 将提取的字符串转换为与fullHistory相同的对象结构
                    matches.forEach(content => {
                        extractedContents.push({ role: msg.role, content: content });
                    });
                }
            });
        });

        // 如果有提取的内容，构建新的历史记录
        if (extractedContents.length > 0) {
            fullHistory = extractedContents;
        }
    }

    const formattedHistory = fullHistory.map(msg => `${msg.role}："${msg.content}"`).join(' \n ');

    const prompts = apiSettings.prompts || [];

    // 遍历提示词列表构建消息
    for (const prompt of prompts) {
      const processedContent = performReplacements(prompt.content);

      // 特殊处理: finalSystemDirective 仅用于提取，不发送给API
      if (prompt.id === 'finalSystemDirective') {
        finalSystemDirectiveContent = processedContent;
        continue;
      }

      // 特殊处理: 在 systemPrompt (Prompt 2) 之前注入上下文
      // 只有当 id 明确匹配 'systemPrompt' 时才注入。如果用户删除了它（虽然UI禁止），则不注入？
      // 用户要求: "上下文读取位置也固定在提示词2的上方不变"
      if (prompt.id === 'systemPrompt' && formattedHistory) {
        messages.push({
          role: 'system',
          content: `以下是前文的用户记录和故事发展，给你用作参考：\n ${formattedHistory}`,
        });
      }

      messages.push({
        role: prompt.role || 'system', // 默认为 system
        content: processedContent,
      });
    }

    const minLength = settings.minLength || 0;
    let processedMessage = null;
    const maxRetries = 3;

    if (minLength > 0) {
      for (let i = 0; i < maxRetries; i++) {
        $toast.find('.toastr-message').text(`正在规划剧情... (尝试 ${i + 1}/${maxRetries})`);
        // 直接传递构建好的 messages 数组
        const tempMessage = await callInterceptionApi(messages, finalApiSettings);
        if (tempMessage && tempMessage.length >= minLength) {
          processedMessage = tempMessage;
          if ($toast) toastr.clear($toast);
          toastr.success(`剧情规划成功 (第 ${i + 1} 次尝试)。`, '成功');
          break;
        }
        if (i < maxRetries - 1) {
          toastr.warning(`回复过短，准备重试...`, '剧情规划大师', { timeOut: 2000 });
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } else {
      processedMessage = await callInterceptionApi(messages, finalApiSettings);
    }

    if (processedMessage) {
      // [架构重构] 将本次优化结果暂存（保存完整回复）
      tempPlotToSave = processedMessage;

      // [新功能] 标签摘取逻辑
      let messageForTavern = processedMessage; // 默认使用完整回复
      const tagsToExtract = (finalApiSettings.extractTags || '').trim();

      if (tagsToExtract) {
        const tagNames = tagsToExtract
          .split(',')
          .map(t => t.trim())
          .filter(t => t);
        if (tagNames.length > 0) {
          const extractedParts = [];

          tagNames.forEach(tagName => {
            const safeTagName = escapeRegExp(tagName);
            const regex = new RegExp(`<${safeTagName}>([\\s\\S]*?)<\\/${safeTagName}>`, 'gi');
            const matches = processedMessage.match(regex);
            // [逻辑修改] 只提取最后一个满足条件的标签
            if (matches && matches.length > 0) {
              extractedParts.push(matches[matches.length - 1]);
            }
          });

          if (extractedParts.length > 0) {
            messageForTavern = extractedParts.join('\n\n');
            console.log(`[${extension_name}] 成功摘取标签: ${tagNames.join(', ')}`);
            toastr.info(`已成功摘取 [${tagNames.join(', ')}] 标签内容并注入。`, '标签摘取');
          } else {
            console.log(`[${extension_name}] 在回复中未找到指定标签: ${tagNames.join(', ')}`);
          }
        }
      }

      // 使用可能被处理过的 messageForTavern 构建最终消息
      const finalMessage = `${userMessage}\n\n${finalSystemDirectiveContent}\n${messageForTavern}`;

      if ($toast) toastr.clear($toast);
      if (minLength <= 0) {
        toastr.success('剧情规划大师已完成规划。', '规划成功');
      }
      return finalMessage;
    } else {
      if ($toast) toastr.clear($toast);
      if (minLength > 0) {
        toastr.error(`重试 ${maxRetries} 次后回复依然过短，操作已取消。`, '规划失败');
      }
      return null;
    }
  } catch (error) {
    console.error(`[${extension_name}] 在核心优化逻辑中发生错误:`, error);
    if ($toast) toastr.clear($toast);
    toastr.error('剧情规划大师在处理时发生错误。', '规划失败');
    return null;
  }
}

async function onGenerationAfterCommands(type, params, dryRun) {
  // 如果消息已被TavernHelper钩子处理，则跳过
  if (params?._qrf_processed_by_hook) {
    return;
  }

  const settings = extension_settings[extension_name] || {};
  if (type === 'regenerate' || isProcessing || dryRun || !settings.enabled) {
    return;
  }

  const context = getContext();

  // [策略1] 检查最新的聊天消息 (主要用于 /send 等命令，这些命令会先创建消息再触发生成)
  if (context && context.chat && context.chat.length > 0) {
    const lastMessageIndex = context.chat.length - 1;
    const lastMessage = context.chat[lastMessageIndex];

    // If the last message is a new user message, process it.
    if (lastMessage && lastMessage.is_user && !lastMessage._qrf_processed) {
      lastMessage._qrf_processed = true; // Prevent reprocessing

      const messageToProcess = lastMessage.mes;
      if (messageToProcess && messageToProcess.trim().length > 0) {
        isProcessing = true;
        try {
          const finalMessage = await runOptimizationLogic(messageToProcess);
          if (finalMessage) {
            params.prompt = finalMessage; // Inject into generation
            lastMessage.mes = finalMessage; // Update chat history

            // [UI修复] 发送消息更新事件以刷新UI
            eventSource.emit(event_types.MESSAGE_UPDATED, lastMessageIndex);

            // Clean the textarea if it contains the original text
            if ($('#send_textarea').val() === messageToProcess) {
              $('#send_textarea').val('');
              $('#send_textarea').trigger('input');
            }
          }
        } catch (error) {
          console.error(`[${extension_name}] Error processing last chat message:`, error);
          delete lastMessage._qrf_processed; // Allow retry on error
        } finally {
          isProcessing = false;
        }
        return; // Strategy 1 was successful, so we stop here.
      }
    }
  }

  // [策略2] 检查主输入框 (用于用户在UI中直接输入并点击发送)
  const textInBox = $('#send_textarea').val();
  if (textInBox && textInBox.trim().length > 0) {
    isProcessing = true;
    try {
      const finalMessage = await runOptimizationLogic(textInBox);
      if (finalMessage) {
        $('#send_textarea').val(finalMessage);
        $('#send_textarea').trigger('input');
      }
    } catch (error) {
      console.error(`[${extension_name}] Error processing textarea input:`, error);
    } finally {
      isProcessing = false;
    }
  }
}

function loadPluginStyles() {
  const styleId = `${extension_name}-style`;
  if (document.getElementById(styleId)) return;
  const styleUrl = `scripts/extensions/third-party/${extension_name}/style.css?v=${Date.now()}`;
  const linkElement = document.createElement('link');
  linkElement.id = styleId;
  linkElement.rel = 'stylesheet';
  linkElement.type = 'text/css';
  linkElement.href = styleUrl;
  document.head.appendChild(linkElement);
}

jQuery(async () => {
  // [彻底修复] 执行一个健壮的、非破坏性的设置初始化。
  // 此方法会保留所有用户已保存的设置，仅当设置项不存在时才从默认值中添加。
  if (!extension_settings[extension_name]) {
    extension_settings[extension_name] = {};
  }
  const settings = extension_settings[extension_name];

  // 确保 apiSettings 子对象存在
  if (!settings.apiSettings) {
    settings.apiSettings = {};
  }

  // 1. 遍历并应用顶层设置的默认值
  for (const key in defaultSettings) {
    if (key !== 'apiSettings' && settings[key] === undefined) {
      settings[key] = defaultSettings[key];
    }
  }

  // 2. 遍历并应用 apiSettings 的默认值
  const defaultApiSettings = defaultSettings.apiSettings;
  for (const key in defaultApiSettings) {
    if (settings.apiSettings[key] === undefined) {
      settings.apiSettings[key] = defaultApiSettings[key];
    }
  }

  // [新功能] 迁移旧设置到新的 prompts 数组
  if (!settings.apiSettings.prompts || settings.apiSettings.prompts.length === 0) {
    console.log(`[${extension_name}] Migrating legacy prompts to new format...`);
    // 检查旧设置是否存在
    const oldMain = settings.apiSettings.mainPrompt;

    // 如果连 mainPrompt 都没有，就使用默认值
    if (!oldMain) {
      settings.apiSettings.prompts = JSON.parse(JSON.stringify(defaultSettings.apiSettings.prompts));
    } else {
      // 使用现有设置构建
      settings.apiSettings.prompts = [
        {
          id: 'mainPrompt',
          name: '主系统提示词 (通用)',
          role: 'system',
          content: settings.apiSettings.mainPrompt || '',
          deletable: false,
        },
        {
          id: 'systemPrompt',
          name: '拦截任务详细指令',
          role: 'user',
          content: settings.apiSettings.systemPrompt || '',
          deletable: false,
        },
        {
          id: 'finalSystemDirective',
          name: '最终注入指令 (Storyteller Directive)',
          role: 'system',
          content: settings.apiSettings.finalSystemDirective || '',
          deletable: false,
        },
      ];
    }
    saveSettings();
  }

  // 确保新增的顶层设置有默认值
  if (settings.minLength === undefined) {
    settings.minLength = 0;
  }

  // 首次加载时，执行一次预设加载和数据清理
  loadPresetAndCleanCharacterData();

  const intervalId = setInterval(async () => {
    // 确保UI和TavernHelper都已加载
    if ($('#extensions_settings').length > 0 && window.TavernHelper) {
      clearInterval(intervalId);
      try {
        loadPluginStyles();
        await createDrawer();

        // [并行方案1] 恢复猴子补丁以拦截直接的JS调用
        if (!window.original_TavernHelper_generate) {
          window.original_TavernHelper_generate = TavernHelper.generate;
        }
        TavernHelper.generate = async function (...args) {
          const options = args[0] || {};
          const settings = extension_settings[extension_name] || {};

          if (!settings.enabled || isProcessing || options.should_stream) {
            return window.original_TavernHelper_generate.apply(this, args);
          }

          let userMessage = options.user_input || options.prompt;
          if (options.injects?.[0]?.content) {
            userMessage = options.injects[0].content;
          }

          if (userMessage) {
            isProcessing = true;
            try {
              const finalMessage = await runOptimizationLogic(userMessage);
              if (finalMessage) {
                // 根据来源写回
                if (options.injects?.[0]?.content) {
                  options.injects[0].content = finalMessage;
                } else if (options.prompt) {
                  options.prompt = finalMessage;
                } else {
                  options.user_input = finalMessage;
                }
                // 添加标志，防止 GENERATION_AFTER_COMMANDS 重复处理
                options._qrf_processed_by_hook = true;
              }
            } catch (error) {
              console.error(`[${extension_name}] Error in TavernHelper.generate hook:`, error);
            } finally {
              isProcessing = false;
            }
          }

          return window.original_TavernHelper_generate.apply(this, args);
        };

        // [并行方案2] 注册事件监听器
        if (!window.qrfEventsRegistered) {
          // 核心拦截点：处理主输入框和 /send 命令
          eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);

          // 辅助功能
          eventSource.on(event_types.GENERATION_ENDED, savePlotToLatestMessage);
          eventSource.on(event_types.CHAT_CHANGED, loadPresetAndCleanCharacterData);

          window.qrfEventsRegistered = true;
          console.log(`[${extension_name}] Parallel event listeners registered.`);
        }
      } catch (error) {
        console.error(`[${extension_name}] Initialization failed:`, error);
        if (window.original_TavernHelper_generate) {
          TavernHelper.generate = window.original_TavernHelper_generate;
        }
      }
    }
  }, 100);
});
