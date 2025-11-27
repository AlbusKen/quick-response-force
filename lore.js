// lore.js
// 世界书处理模块
import { characters, this_chid } from '/script.js';

const extensionName = 'quick-response-force';

/**
 * 获取合并后的世界书内容 (移植自数据库插件的先进逻辑)
 * @param {object} context - SillyTavern上下文
 * @param {object} apiSettings - API设置
 * @param {string} userMessage - 当前的用户输入
 * @returns {Promise<string>} - 合并后的、经过递归和关键词处理的世界书内容
 */
export async function getCombinedWorldbookContent(context, apiSettings, userMessage) {
  if (!apiSettings.worldbookEnabled) {
    return '';
  }

  console.log(`[${extensionName}] Starting to get combined worldbook content with advanced logic...`);

  try {
    let bookNames = [];

    // 1. 确定要扫描的世界书
    if (apiSettings.worldbookSource === 'manual') {
      bookNames = apiSettings.selectedWorldbooks || [];
    } else {
      // 'character' mode
      if (this_chid === -1 || !characters[this_chid]) {
        console.warn(`[${extensionName}] 没有选择角色，无法获取角色世界书`);
        return '';
      }
      try {
        const charLorebooks = await window.TavernHelper.getCharLorebooks({ type: 'all' });
        if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
        if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
      } catch (error) {
        console.error(`[${extensionName}] 获取角色世界书失败:`, error);
        return '';
      }
    }

    if (bookNames.length === 0) {
      console.log(`[${extensionName}] No worldbooks selected or available for the character.`);
      return '';
    }

    // 2. 获取所有相关世界书的全部条目
    let allEntries = [];
    for (const bookName of bookNames) {
      if (bookName) {
        const entries = await window.TavernHelper.getLorebookEntries(bookName);
        if (entries?.length) {
          entries.forEach(entry => allEntries.push({ ...entry, bookName }));
        }
      }
    }

    // 3. 过滤掉在SillyTavern中被禁用的条目，以及用户在插件UI中取消勾选的条目
    const disabledEntriesFromSettings = apiSettings.disabledWorldbookEntries;

    // 如果设置为 "__ALL_SELECTED__"，则意味着所有条目都被启用（除了在ST本身被禁用的）
    const isAllSelected = disabledEntriesFromSettings === '__ALL_SELECTED__';
    const disabledMap =
      typeof disabledEntriesFromSettings === 'object' && disabledEntriesFromSettings !== null
        ? disabledEntriesFromSettings
        : {};

    const userEnabledEntries = allEntries.filter(entry => {
      // 1. 必须在SillyTavern本身是启用的
      if (!entry.enabled) return false;

      // 2. 如果是全选状态，则通过
      if (isAllSelected) return true;

      // 3. 检查是否在禁用列表中
      const disabledInBook = disabledMap[entry.bookName];
      if (disabledInBook && Array.isArray(disabledInBook) && disabledInBook.includes(entry.uid)) {
        return false;
      }

      // 默认为启用
      return true;
    });

    if (userEnabledEntries.length === 0) {
      console.log(`[${extensionName}] No entries are enabled in the plugin settings or available.`);
      return '';
    }

    // 4. 开始递归激活逻辑
    const initialScanText = `${context.chat.map(message => message.mes).join('\n')}\n${
      userMessage || ''
    }`.toLowerCase();
    const getEntryKeywords = entry =>
      [...new Set([...(entry.key || []), ...(entry.keys || [])])].map(k => k.toLowerCase());

    const constantEntries = userEnabledEntries.filter(entry => entry.type === 'constant');
    let keywordEntries = userEnabledEntries.filter(entry => entry.type !== 'constant');

    const triggeredEntries = new Set([...constantEntries]);
    let recursionDepth = 0;
    const MAX_RECURSION_DEPTH = 10; // 防止无限递归的安全措施

    while (recursionDepth < MAX_RECURSION_DEPTH) {
      recursionDepth++;
      let hasChangedInThisPass = false;

      // 递归扫描源 = 初始文本（历史+用户输入） + 已触发且不阻止递归的条目内容
      const recursionSourceContent = Array.from(triggeredEntries)
        .filter(e => !e.prevent_recursion)
        .map(e => e.content)
        .join('\n')
        .toLowerCase();
      const fullSearchText = `${initialScanText}\n${recursionSourceContent}`;

      const remainingKeywordEntries = [];

      for (const entry of keywordEntries) {
        const keywords = getEntryKeywords(entry);
        // 如果条目有关键词，并且其中至少一个关键词能在扫描源中找到，则触发
        // 'exclude_recursion' 只在初始文本中搜索，否则在完整扫描源中搜索
        let isTriggered =
          keywords.length > 0 &&
          keywords.some(keyword =>
            entry.exclude_recursion ? initialScanText.includes(keyword) : fullSearchText.includes(keyword),
          );

        if (isTriggered) {
          triggeredEntries.add(entry);
          hasChangedInThisPass = true;
        } else {
          remainingKeywordEntries.push(entry);
        }
      }

      if (!hasChangedInThisPass) {
        console.log(`[${extensionName}] Worldbook recursion stabilized after ${recursionDepth} passes.`);
        break;
      }

      keywordEntries = remainingKeywordEntries;
    }

    if (recursionDepth >= MAX_RECURSION_DEPTH) {
      console.warn(
        `[${extensionName}] Worldbook recursion reached max depth of ${MAX_RECURSION_DEPTH}. Breaking loop.`,
      );
    }

    // 5. 格式化最终内容
    const finalContent = Array.from(triggeredEntries)
      .map(entry => {
        if (entry.content && entry.content.trim()) {
          return `[Worldbook Entry: ${entry.comment || `Entry from ${entry.bookName}`}]\n${entry.content}`;
        }
        return null;
      })
      .filter(Boolean);

    if (finalContent.length === 0) {
      console.log(`[${extensionName}] No worldbook entries were ultimately triggered.`);
      return '';
    }

    const combinedContent = finalContent.join('\n\n');
    console.log(
      `[${extensionName}] Combined worldbook content generated, length: ${combinedContent.length}. ${triggeredEntries.size} entries triggered.`,
    );

    // 6. 应用字符数限制
    const limit = apiSettings.worldbookCharLimit || 60000;
    if (combinedContent.length > limit) {
      console.log(
        `[${extensionName}] Worldbook content truncated from ${combinedContent.length} to ${limit} characters.`,
      );
      return combinedContent.substring(0, limit);
    }

    return combinedContent;
  } catch (error) {
    console.error(`[${extensionName}] 处理世界书内容时发生错误:`, error);
    return ''; // 发生错误时返回空字符串，避免中断生成
  }
}
