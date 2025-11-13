// lore.js
// 世界书处理模块
import { characters, this_chid } from '/script.js';

const extensionName = 'quick-response-force';

/**
 * 获取合并后的世界书内容
 * @param {object} context - SillyTavern上下文
 * @param {object} apiSettings - API设置
 * @returns {Promise<string>} - 合并后的世界书内容
 */
export async function getCombinedWorldbookContent(context, apiSettings) {
  if (!apiSettings.worldbookEnabled) {
    return '';
  }

  try {
    let worldbookContent = '';
    let bookNames = [];

    // 确定世界书来源
    if (apiSettings.worldbookSource === 'manual') {
      bookNames = apiSettings.selectedWorldbooks || [];
    } else {
      // 使用角色的世界书
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

    // 获取每个世界书的条目
    const disabledEntries = apiSettings.disabledWorldbookEntries || {};
    let totalEntries = [];
    let enabledEntries = [];

    for (const bookName of bookNames) {
      try {
        const entries = await window.TavernHelper.getLorebookEntries(bookName);
        entries.forEach(entry => {
          // 只处理启用的条目
          if (entry.enabled) {
            const isDisabled = disabledEntries[bookName]?.includes(entry.uid);
            if (!isDisabled) {
              enabledEntries.push(entry);
            }
          }
        });
      } catch (error) {
        console.error(`[${extensionName}] 获取世界书 ${bookName} 的条目失败:`, error);
      }
    }

    // 按评论排序并格式化条目
    enabledEntries.sort((a, b) => (a.comment || '').localeCompare(b.comment || ''));

    // 构建世界书内容
    for (const entry of enabledEntries) {
      if (entry.content && entry.content.trim()) {
        worldbookContent += `\n[世界书条目]: ${entry.comment}\n${entry.content}\n`;
      }
    }

    return worldbookContent;
  } catch (error) {
    console.error(`[${extensionName}] 处理世界书内容时发生错误:`, error);
    return '';
  }
}
