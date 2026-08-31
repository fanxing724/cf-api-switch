/**
 * 请求侧转换
 *
 * 统一中间表示（internal）采用 Responses API 的语义：
 *   { instructions, input[], tools[], toolChoice, ... }
 * 入站协议先归一到 internal，再由 internal 渲染成目标上游协议。
 */

import { boolEnv } from '../config.js';

/* ------------------------------------------------------------------ */
/* 入站：OpenAI chat/completions → internal                            */
/* ------------------------------------------------------------------ */

/** 把 chat 协议的 user 消息内容片段转成 Responses 的 input content part */
function chatPartToInputPart(part) {
  if (typeof part === 'string') return { type: 'input_text', text: part };
  if (!part || typeof part !== 'object') return null;

  switch (part.type) {
    case 'text':
      return { type: 'input_text', text: part.text ?? '' };
    case 'image_url': {
      const url = part.image_url?.url ?? part.image_url;
      if (!url) return null;
      const detail = part.image_url?.detail;
      const out = { type: 'input_image', image_url: url };
      if (detail) out.detail = detail;
      return out;
    }
    case 'input_image':
      return part;
    case 'input_text':
      return part;
    case 'file': {
      // 部分兼容层用 file 传文档
      if (part.file?.file_data) {
        return { type: 'input_file', file_data: part.file.file_data, filename: part.file.filename };
      }
      if (part.file?.file_id) return { type: 'input_file', file_id: part.file.file_id };
      return null;
    }
    case 'input_file':
      return part;
    default:
      // 不认识的片段原样透传，最大程度保真
      return part;
  }
}

/** 把 chat 协议的 assistant 消息内容转成 Responses 的 output content part */
function chatAssistantPartToOutputPart(part) {
  if (typeof part === 'string') return { type: 'output_text', text: part, annotations: [] };
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') return { type: 'output_text', text: part.text ?? '', annotations: part.annotations ?? [] };
  if (part.type === 'output_text') return part;
  if (part.type === 'refusal') return { type: 'refusal', refusal: part.refusal ?? part.text ?? '' };
  return part;
}

function normalizeContentToArray(content) {
  if (content === null || content === undefined) return [];
  return Array.isArray(content) ? content : [content];
}

export function chatToInternal(body) {
  const warnings = [];
  const instructionsParts = [];
  const input = [];
  const stopSequences = [];

  for (const msg of body.messages || []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role || 'user';

    // ---- system / developer：提到 instructions --------------------------
    if (role === 'system' || role === 'developer') {
      const text = normalizeContentToArray(msg.content)
        .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
        .filter(Boolean)
        .join('\n\n');
      if (text) instructionsParts.push(text);
      continue;
    }

    // ---- tool 结果 -----------------------------------------------------
    if (role === 'tool') {
      const raw = msg.content;
      let output = '';
      if (typeof raw === 'string') output = raw;
      else if (Array.isArray(raw)) {
        output = raw
          .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
          .filter(Boolean)
          .join('\n');
      } else if (raw && typeof raw === 'object') output = raw.text ?? '';
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id ?? msg.toolCallId ?? '',
        output,
      });
      continue;
    }

    // ---- user ----------------------------------------------------------
    if (role === 'user') {
      const parts = normalizeContentToArray(msg.content)
        .map(chatPartToInputPart)
        .filter(Boolean);
      if (parts.length) {
        input.push({ type: 'message', role: 'user', content: parts });
      }
      continue;
    }

    // ---- assistant -----------------------------------------------------
    if (role === 'assistant') {
      const parts = normalizeContentToArray(msg.content)
        .map(chatAssistantPartToOutputPart)
        .filter(Boolean);
      const hasText = parts.length > 0;

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        // 先落文本（若有），再逐个落 function_call item
        if (hasText) {
          const name = msg.name ? { name: msg.name } : {};
          input.push({ type: 'message', role: 'assistant', content: parts, status: 'completed', ...name });
        }
        for (const call of msg.tool_calls) {
          if (!call || call.type !== 'function') continue;
          input.push({
            type: 'function_call',
            call_id: call.id ?? '',
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '',
          });
        }
      } else if (hasText) {
        const name = msg.name ? { name: msg.name } : {};
        input.push({ type: 'message', role: 'assistant', content: parts, status: 'completed', ...name });
      }
    }
  }

  // ---- stop ------------------------------------------------------------
  if (Array.isArray(body.stop)) stopSequences.push(...body.stop.filter((s) => typeof s === 'string'));
  else if (typeof body.stop === 'string') stopSequences.push(body.stop);

  // ---- response_format -------------------------------------------------
  let textFormat = null;
  if (body.response_format) {
    const rf = body.response_format;
    if (rf.type === 'json_object') textFormat = { type: 'json_object' };
    else if (rf.type === 'json_schema' && rf.json_schema) {
      textFormat = {
        type: 'json_schema',
        name: rf.json_schema.name || 'response',
        schema: rf.json_schema.schema,
        strict: rf.json_schema.strict ?? false,
      };
    } else if (rf.type === 'text') {
      textFormat = null;
    } else {
      warnings.push(`response_format.type=${rf.type} 未做映射，已忽略`);
    }
  }

  // ---- tools -----------------------------------------------------------
  let tools = null;
  if (Array.isArray(body.tools) && body.tools.length) {
    tools = body.tools
      .map((tool) => {
        if (!tool || typeof tool !== 'object') return null;
        // 标准 function tool：chat 是两层包装，Responses 是扁平结构
        if (tool.type === 'function' && tool.function) {
          const out = {
            type: 'function',
            name: tool.function.name,
            description: tool.function.description ?? '',
            parameters: tool.function.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
          };
          if (tool.function.strict !== undefined) out.strict = tool.function.strict;
          return out;
        }
        // 已经是扁平结构（Responses 原生工具或客户端直接传新版格式）
        if (tool.type === 'function') {
          const { type, ...rest } = tool;
          return { type: 'function', ...rest };
        }
        // web_search_preview / file_search / computer_use / mcp 等 Responses 原生工具，原样透传
        return tool;
      })
      .filter(Boolean);
    if (!tools.length) tools = null;
  }

  // ---- tool_choice -----------------------------------------------------
  let toolChoice;
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    const tc = body.tool_choice;
    if (typeof tc === 'string') {
      toolChoice = tc; // none / auto / required
    } else if (tc.type === 'function' && tc.function?.name) {
      toolChoice = { type: 'function', name: tc.function.name };
    } else if (tc.type === 'function' && tc.name) {
      toolChoice = { type: 'function', name: tc.name };
    } else if (tc.type === 'allowed_tools' || tc.type === 'custom' || tc.type === 'file_search') {
      toolChoice = tc; // Responses 原生选择方式，透传
    }
  }

  // ---- 参数映射告警 ----------------------------------------------------
  const dropped = [];
  for (const key of ['seed', 'logprobs', 'top_logprobs', 'logit_bias', 'n', 'presence_penalty', 'frequency_penalty', 'functions', 'function_call', 'audio', 'modalities', 'prediction']) {
    if (body[key] !== undefined) dropped.push(key);
  }
  if (dropped.length) warnings.push(`新协议不支持的字段已忽略: ${dropped.join(', ')}`);

  return {
    internal: {
      model: body.model,
      instructions: instructionsParts.join('\n\n') || undefined,
      input,
      tools,
      toolChoice,
      parallelToolCalls: body.parallel_tool_calls,
      temperature: body.temperature,
      topP: body.top_p,
      maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
      textFormat,
      verbosity: body.verbosity,
      reasoning: normaliseReasoning(body),
      stream: !!body.stream,
      user: body.user,
      stopSequences,
      metadata: body.metadata,
      previousResponseId: body.previous_response_id,
      serviceTier: body.service_tier,
      promptCacheKey: body.prompt_cache_key ?? body.safety_identifier,
      store: body.store,
      truncation: body.truncation,
    },
    warnings,
  };
}

function normaliseReasoning(body) {
  const raw = body.reasoning ?? (body.reasoning_effort ? { effort: body.reasoning_effort } : null);
  if (!raw) return undefined;
  if (typeof raw === 'string') return { effort: raw };
  if (typeof raw !== 'object') return undefined;
  const out = {};
  if (raw.effort) out.effort = raw.effort;
  if (raw.summary) out.summary = raw.summary;
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------------------------------------------------ */
/* 入站：Anthropic Messages → internal                                  */
/* ------------------------------------------------------------------ */

function anthropicSystemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

export function anthropicToInternal(body) {
  const warnings = [];
  const input = [];
  const instructions = anthropicSystemToText(body.system) || undefined;

  for (const msg of body.messages || []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;

    if (role === 'user') {
      if (typeof msg.content === 'string') {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: msg.content }] });
        continue;
      }
      const parts = [];
      for (const block of msg.content || []) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          parts.push({ type: 'input_text', text: block.text ?? '' });
        } else if (block.type === 'image') {
          const src = block.source || {};
          if (src.type === 'base64') {
            parts.push({
              type: 'input_image',
              image_url: `data:${src.media_type || 'image/png'};base64,${src.data || ''}`,
              detail: 'auto',
            });
          } else if (src.type === 'url' && src.url) {
            parts.push({ type: 'input_image', image_url: src.url, detail: 'auto' });
          } else if (src.type === 'file' && src.file_id) {
            parts.push({ type: 'input_file', file_id: src.file_id });
          }
        } else if (block.type === 'tool_result') {
          let output = '';
          if (typeof block.content === 'string') output = block.content;
          else if (Array.isArray(block.content)) {
            output = block.content
              .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
              .filter(Boolean)
              .join('\n');
          }
          if (block.is_error) output = `[tool error] ${output}`;
          input.push({
            type: 'function_call_output',
            call_id: block.tool_use_id ?? '',
            output,
          });
        } else if (block.type === 'document' || block.type === 'search_result') {
          // Anthropic 特有块，降维成文本，避免整条请求失败
          const text = block.content ?? block.text ?? block.title ?? '';
          if (text) {
            parts.push({
              type: 'input_text',
              text: typeof text === 'string' ? `[${block.type}] ${text}` : `[${block.type}]`,
            });
          }
          warnings.push(`Anthropic 的 ${block.type} 块已降级为纯文本`);
        }
      }
      if (parts.length) input.push({ type: 'message', role: 'user', content: parts });
      continue;
    }

    if (role === 'assistant') {
      if (typeof msg.content === 'string') {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: msg.content, annotations: [] }],
          status: 'completed',
        });
        continue;
      }
      const textParts = [];
      const calls = [];
      for (const block of msg.content || []) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          textParts.push({ type: 'output_text', text: block.text ?? '', annotations: [] });
        } else if (block.type === 'tool_use') {
          calls.push({
            type: 'function_call',
            call_id: block.id ?? '',
            name: block.name ?? '',
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
          });
        } else if (block.type === 'thinking') {
          // 思考块不做回放（Responses 侧由模型自行产生 reasoning item）
          warnings.push('Anthropic thinking 块已跳过');
        }
      }
      if (textParts.length) {
        input.push({ type: 'message', role: 'assistant', content: textParts, status: 'completed' });
      }
      for (const call of calls) input.push(call);
    }
  }

  // ---- tools -----------------------------------------------------------
  let tools = null;
  if (Array.isArray(body.tools) && body.tools.length) {
    tools = body.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    }));
  }

  // ---- tool_choice -----------------------------------------------------
  let toolChoice;
  if (body.tool_choice) {
    if (typeof body.tool_choice === 'string') toolChoice = body.tool_choice;
    else if (body.tool_choice.type === 'auto') toolChoice = 'auto';
    else if (body.tool_choice.type === 'any') toolChoice = 'required';
    else if (body.tool_choice.type === 'tool') toolChoice = { type: 'function', name: body.tool_choice.name };
    else if (body.tool_choice.type === 'none') toolChoice = 'none';
  }

  const stopSequences = Array.isArray(body.stop_sequences) ? body.stop_sequences.filter((s) => typeof s === 'string') : [];

  return {
    internal: {
      model: body.model,
      instructions,
      input,
      tools,
      toolChoice,
      parallelToolCalls: body.disable_parallel_tool_calls === true ? false : undefined,
      temperature: body.temperature,
      topP: body.top_p,
      maxOutputTokens: body.max_tokens,
      textFormat: null,
      stream: !!body.stream,
      user: body.metadata?.user_id,
      stopSequences,
      metadata: body.metadata,
      store: false,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 出站：internal → Responses API 请求体                                */
/* ------------------------------------------------------------------ */

export function internalToResponses(internal, env) {
  const payload = { model: internal.model };

  // input 支持字符串捷径：纯文本单轮时更省 token，也更接近手写的 Responses 调用
  if (internal.input.length === 1 && internal.input[0].type === 'message' && internal.input[0].role === 'user') {
    const content = internal.input[0].content || [];
    if (content.length === 1 && content[0].type === 'input_text') {
      payload.input = content[0].text;
    } else {
      payload.input = internal.input;
    }
  } else {
    payload.input = internal.input;
  }

  let instructions = internal.instructions;

  // 新协议没有 stop，降级为软提示
  if (boolEnv(env?.STOP_AS_HINT, true) && internal.stopSequences?.length) {
    const hint = `Stop generating immediately when you produce any of the following sequences: ${internal.stopSequences
      .map((s) => JSON.stringify(s))
      .join(', ')}. Do not include them in the output.`;
    instructions = instructions ? `${instructions}\n\n${hint}` : hint;
  }
  if (instructions) payload.instructions = instructions;

  if (internal.maxOutputTokens !== undefined && internal.maxOutputTokens !== null) {
    payload.max_output_tokens = internal.maxOutputTokens;
  }
  if (internal.temperature !== undefined && internal.temperature !== null) payload.temperature = internal.temperature;
  if (internal.topP !== undefined && internal.topP !== null) payload.top_p = internal.topP;
  if (internal.parallelToolCalls !== undefined) payload.parallel_tool_calls = internal.parallelToolCalls;
  if (internal.tools) payload.tools = internal.tools;
  if (internal.toolChoice !== undefined) payload.tool_choice = internal.toolChoice;

  // text.format / verbosity
  const text = {};
  if (internal.textFormat) text.format = internal.textFormat;
  if (internal.verbosity) text.verbosity = internal.verbosity;
  if (Object.keys(text).length) payload.text = text;

  if (internal.reasoning) payload.reasoning = internal.reasoning;
  if (internal.user) payload.user = internal.user;
  if (internal.previousResponseId) payload.previous_response_id = internal.previousResponseId;
  if (internal.serviceTier) payload.service_tier = internal.serviceTier;
  if (internal.promptCacheKey) payload.prompt_cache_key = internal.promptCacheKey;
  if (internal.metadata) payload.metadata = internal.metadata;

  payload.stream = !!internal.stream;
  // 默认不落库：省存储、也更符合「网关」定位
  payload.store = internal.store !== undefined ? internal.store : boolEnv(env?.STORE_RESPONSE, false);
  if (internal.truncation) payload.truncation = internal.truncation;

  return payload;
}

/* ------------------------------------------------------------------ */
/* 出站：internal → chat/completions 请求体（上游只支持旧协议时）       */
/* ------------------------------------------------------------------ */

export function internalToChat(internal, env) {
  const messages = [];
  if (internal.instructions) messages.push({ role: 'system', content: internal.instructions });

  // 把相邻的 assistant 文本 + function_call 合并回一条 chat assistant 消息
  let pendingAssistant = null;

  const flushAssistant = () => {
    if (pendingAssistant) {
      const msg = { role: 'assistant', content: pendingAssistant.text || null };
      if (pendingAssistant.toolCalls.length) msg.tool_calls = pendingAssistant.toolCalls;
      messages.push(msg);
      pendingAssistant = null;
    }
  };

  for (const item of internal.input || []) {
    if (item.type === 'message' && (item.role === 'user' || item.role === 'system' || item.role === 'developer')) {
      flushAssistant();
      const parts = (item.content || [])
        .map((c) => {
          if (c.type === 'input_text') return { type: 'text', text: c.text };
          if (c.type === 'input_image') return { type: 'image_url', image_url: { url: c.image_url } };
          return c;
        })
        .filter(Boolean);
      const role = item.role === 'developer' ? 'system' : item.role;
      const onlyText = parts.length <= 1 && parts[0]?.type === 'text';
      messages.push({ role, content: onlyText ? parts[0].text : parts });
      continue;
    }

    if (item.type === 'message' && item.role === 'assistant') {
      flushAssistant();
      const text = (item.content || [])
        .map((c) => (c.type === 'output_text' ? c.text : ''))
        .filter(Boolean)
        .join('');
      pendingAssistant = { text, toolCalls: [] };
      continue;
    }

    if (item.type === 'function_call') {
      if (!pendingAssistant) pendingAssistant = { text: '', toolCalls: [] };
      pendingAssistant.toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '' },
      });
      continue;
    }

    if (item.type === 'function_call_output') {
      flushAssistant();
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output ?? '' });
    }
  }
  flushAssistant();

  const payload = { model: internal.model, messages };

  if (internal.maxOutputTokens !== undefined) payload.max_tokens = internal.maxOutputTokens;
  if (internal.temperature !== undefined) payload.temperature = internal.temperature;
  if (internal.topP !== undefined) payload.top_p = internal.topP;
  if (internal.stream) payload.stream = true;
  if (internal.parallelToolCalls !== undefined) payload.parallel_tool_calls = internal.parallelToolCalls;

  if (internal.tools?.length) {
    payload.tools = internal.tools.map((t) =>
      t.type === 'function'
        ? {
            type: 'function',
            function: {
              name: t.name,
              description: t.description ?? '',
              parameters: t.parameters ?? { type: 'object', properties: {} },
              ...(t.strict !== undefined ? { strict: t.strict } : {}),
            },
          }
        : t,
    );
  }

  if (internal.toolChoice !== undefined) {
    const tc = internal.toolChoice;
    if (typeof tc === 'string') payload.tool_choice = tc;
    else if (tc.type === 'function' && tc.name) payload.tool_choice = { type: 'function', function: { name: tc.name } };
    else payload.tool_choice = tc;
  }

  if (internal.textFormat?.type === 'json_object') payload.response_format = { type: 'json_object' };
  else if (internal.textFormat?.type === 'json_schema') {
    payload.response_format = {
      type: 'json_schema',
      json_schema: { name: internal.textFormat.name || 'response', schema: internal.textFormat.schema, strict: internal.textFormat.strict ?? false },
    };
  }

  if (internal.stopSequences?.length) payload.stop = internal.stopSequences;
  if (internal.user) payload.user = internal.user;

  return payload;
}
