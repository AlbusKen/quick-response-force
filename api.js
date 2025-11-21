// api.js
// [重构] 核心API模块，支持“自定义API”和“酒馆预设”两种模式
import { getRequestHeaders } from '/script.js';
import { getContext } from '/scripts/extensions.js';

const extensionName = 'quick-response-force';

/**
 * 统一处理和规范化API响应数据。
 */
function normalizeApiResponse(responseData) {
  let data = responseData;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (e) {
      console.error(`[${extensionName}] API响应JSON解析失败:`, e);
      return { error: { message: 'Invalid JSON response' } };
    }
  }

  if (data && data.choices && data.choices[0]) {
    return { content: data.choices[0].message?.content?.trim() };
  }
  if (data && data.content) {
    return { content: data.content.trim() };
  }
  if (data && data.models) {
    return { data: data.models };
  }
  if (data && data.data) {
    return { data: data.data };
  }
  if (data && data.error) {
    return { error: data.error };
  }
  return data;
}

/**
 * 主API调用入口，根据设置选择不同的模式
 */
export async function callInterceptionApi(
  userMessage,
  contextMessages,
  apiSettings,
  worldbookContent,
  tableDataContent,
) {
  const replacePlaceholders = text => {
    if (typeof text !== 'string') return '';
    const worldbookReplacement =
      apiSettings.worldbookEnabled && worldbookContent
        ? `\n<worldbook_context>\n${worldbookContent}\n</worldbook_context>\n`
        : '';
    text = text.replace(/(?<!\\)\$1/g, worldbookReplacement);
    const tableDataReplacement = tableDataContent
      ? `\n<table_data_context>\n${tableDataContent}\n</table_data_context>\n`
      : '';
    text = text.replace(/(?<!\\)\$5/g, tableDataReplacement);
    return text;
  };

  const messages = [];
  if (apiSettings.mainPrompt) {
    messages.push({ role: 'system', content: replacePlaceholders(apiSettings.mainPrompt) });
  }

  const fullHistory = Array.isArray(contextMessages) ? [...contextMessages] : [];
  if (userMessage) {
    fullHistory.push({ role: 'user', content: userMessage });
  }

  const sanitizeHtml = htmlString => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlString;
    return tempDiv.textContent || tempDiv.innerText || '';
  };

  const formattedHistory = fullHistory.map(msg => `${msg.role}："${sanitizeHtml(msg.content)}"`).join(' \n ');
  if (formattedHistory) {
    messages.push({ role: 'system', content: `以下是前文的用户记录和故事发展，给你用作参考：\n ${formattedHistory}` });
  }

  if (apiSettings.systemPrompt) {
    messages.push({ role: 'user', content: replacePlaceholders(apiSettings.systemPrompt) });
  }

  let result;
  try {
    if (apiSettings.apiMode === 'tavern') {
      // 模式A: 酒馆预设模式
      const profileId = apiSettings.tavernProfile;
      if (!profileId) {
        throw new Error('未选择酒馆连接预设。');
      }
      console.log(`[${extensionName}] 通过酒馆连接预设发送请求...`);
      const context = getContext();
      result = await context.ConnectionManagerRequestService.sendRequest(profileId, messages, apiSettings.maxTokens);
    } else {
      // 模式B: 自定义API模式 (包含 useMainApi 逻辑)
      if (apiSettings.useMainApi) {
        // 子模式 B1: 使用主API
        console.log(`[${extensionName}] 通过酒馆主API发送请求...`);
        if (typeof TavernHelper.generateRaw !== 'function') {
          throw new Error('TavernHelper.generateRaw 函数不存在。请检查酒馆版本。');
        }
        const response = await TavernHelper.generateRaw({
          ordered_prompts: messages,
          should_stream: false,
        });
        if (typeof response !== 'string') {
          throw new Error('主API调用未返回预期的文本响应。');
        }
        return response.trim();
      } else {
        // 子模式 B2: 使用独立配置的API (通过后端代理)
        if (!apiSettings.apiUrl || !apiSettings.model) {
          throw new Error('自定义API的URL或模型未配置。');
        }
        console.log(`[${extensionName}] 通过SillyTavern后端代理发送请求...`);
        const requestBody = {
          messages,
          model: apiSettings.model,
          max_tokens: apiSettings.maxTokens,
          temperature: apiSettings.temperature,
          top_p: apiSettings.topP,
          presence_penalty: apiSettings.presencePenalty,
          frequency_penalty: apiSettings.frequencyPenalty,
          stream: false,
          chat_completion_source: 'custom',
          custom_url: apiSettings.apiUrl,
          custom_include_headers: apiSettings.apiKey ? `Authorization: Bearer ${apiSettings.apiKey}` : '',
        };
        const response = await fetch('/api/backends/chat-completions/generate', {
          method: 'POST',
          headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errTxt = await response.text();
          throw new Error(`API请求失败: ${response.status} ${errTxt}`);
        }

        const data = await response.json();
        result = normalizeApiResponse(data);
      }
    }

    if (result && result.content) {
      return result.content;
    }

    const errorMessage = result?.error?.message || JSON.stringify(result);
    throw new Error(`API调用返回无效响应: ${errorMessage}`);
  } catch (error) {
    console.error(`[${extensionName}] API调用失败:`, error);
    toastr.error(`API调用失败: ${error.message}`, '错误');
    return null;
  }
}

/**
 * 获取模型列表
 */
export async function fetchModels(apiSettings) {
  const { apiUrl, apiKey, useMainApi } = apiSettings;

  if (useMainApi) {
    toastr.info('正在使用主API，模型与酒馆主设置同步。', '提示');
    return [];
  }
  if (!apiUrl) {
    toastr.error('API URL 未配置，无法获取模型列表。', '配置错误');
    return null;
  }

  try {
    const response = await fetch('/api/backends/chat-completions/status', {
      method: 'POST',
      headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_completion_source: 'custom',
        custom_url: apiUrl,
        custom_include_headers: apiKey ? `Authorization: Bearer ${apiKey}` : '',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API状态检查失败: ${response.status} ${errorText}`);
    }

    const rawResponse = await response.json();
    const result = normalizeApiResponse(rawResponse);
    const models = result.data || [];

    if (result.error || !Array.isArray(models)) {
      const errorMessage = result.error?.message || 'API未返回有效的模型列表数组。';
      throw new Error(errorMessage);
    }

    const sortedModels = models.map(m => m.id || m).sort((a, b) => a.localeCompare(b));
    toastr.success(`成功获取 ${sortedModels.length} 个模型`, '操作成功');
    return sortedModels;
  } catch (error) {
    console.error(`[${extensionName}] 获取模型列表时发生错误:`, error);
    toastr.error(`获取模型列表失败: ${error.message}`, 'API错误');
    return null;
  }
}

/**
 * 测试API连接
 */
export async function testApiConnection(apiSettings) {
  console.log(`[${extensionName}] 开始API连接测试...`);
  const { apiUrl, apiKey, model, useMainApi, apiMode, tavernProfile } = apiSettings;

  try {
    if (apiMode === 'tavern') {
      if (!tavernProfile) {
        throw new Error('请选择一个酒馆连接预设用于测试。');
      }
      const context = getContext();
      const profile = context.extensionSettings?.connectionManager?.profiles.find(p => p.id === tavernProfile);
      if (!profile) {
        throw new Error(`无法找到ID为 "${tavernProfile}" 的连接预设。`);
      }
      toastr.success(`测试成功！将使用预设 "${profile.name}"。`, 'API连接正常');
      return true;
    } else {
      // custom mode
      if (useMainApi) {
        toastr.success('连接成功！正在使用酒馆主API。', 'API连接正常');
        return true;
      }

      if (!apiUrl || !model) {
        throw new Error('请先填写 API URL 并选择一个模型用于测试。');
      }

      const testMessages = [{ role: 'user', content: 'Say "Hi"' }];
      const requestBody = {
        messages: testMessages,
        model: model,
        max_tokens: 5,
        temperature: 0.1,
        stream: false,
        chat_completion_source: 'custom',
        custom_url: apiUrl,
        custom_include_headers: apiKey ? `Authorization: Bearer ${apiKey}` : '',
      };

      const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errTxt = await response.text();
        throw new Error(`API请求失败: ${response.status} ${errTxt}`);
      }

      const data = await response.json();
      const result = normalizeApiResponse(data);

      if (result.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }

      if (result.content !== undefined) {
        toastr.success(`测试成功！API返回: "${result.content}"`, 'API连接正常');
        return true;
      } else {
        throw new Error('API响应中未找到有效内容。');
      }
    }
  } catch (error) {
    console.error(`[${extensionName}] API连接测试失败:`, error);
    toastr.error(`测试失败: ${error.message}`, 'API连接失败');
    return false;
  }
}
