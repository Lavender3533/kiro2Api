# 🔧 修复 400 "Improperly formed request" 错误

## 问题诊断

**根本原因**：消息修剪逻辑破坏了 content 格式

### 原始问题
```javascript
// ❌ 错误的做法
const summarized = this.summarizeMessage(content);  // 返回字符串
message.content = summarized;  // 把数组格式改成了字符串
```

如果原始消息是：
```javascript
{
  role: 'user',
  content: [{ type: 'text', text: '...' }, { type: 'image', ... }]  // 数组格式
}
```

修剪后变成：
```javascript
{
  role: 'user',
  content: "截断的内容..."  // 变成字符串！
}
```

这导致 Kiro API 收到格式不一致的请求，返回 **"Improperly formed request"** 错误！

---

## 修复内容

### 1. 修复 `summarizeMessage` 方法（Lines 1167-1191）

**之前**：接收 content，返回字符串
```javascript
summarizeMessage(content) {
    if (Array.isArray(content)) {
        return `${textContent.substring(0, 100)}...`;  // 返回字符串
    }
    return `${content.substring(0, 100)}...`;
}
```

**现在**：接收 message 对象，保持格式
```javascript
summarizeMessage(message) {
    const content = message.content;

    if (Array.isArray(content)) {
        const textContent = content
            .filter(part => part.type === 'text' && part.text)
            .map(part => part.text)
            .join('');
        const truncated = `${textContent.substring(0, 100)}...`;

        // ✅ 返回数组格式，保持一致！
        return [{ type: 'text', text: truncated }];
    }

    // 字符串格式，直接截断
    return `${content.substring(0, 100)}...`;
}
```

### 2. 修复 `pruneChatHistory` 深拷贝（Lines 1205-1212）

**之前**：浅拷贝（破坏 content 数组）
```javascript
const chatHistory = messages.map(msg => ({ ...msg }));
```

**现在**：深拷贝 content 数组
```javascript
const chatHistory = messages.map(msg => ({
    ...msg,
    content: Array.isArray(msg.content)
        ? msg.content.map(part => ({ ...part }))  // 深拷贝！
        : msg.content
}));
```

### 3. 修复所有 6 个阶段的格式保持

**阶段 1**（修剪超长消息，Lines 1252-1257）：
```javascript
// ✅ 保持原始格式
if (Array.isArray(message.content)) {
    message.content = [{ type: 'text', text: prunedText }];
} else {
    message.content = prunedText;
}
```

**阶段 2**（摘要旧消息，Lines 1272-1275）：
```javascript
const summarized = this.summarizeMessage(message);  // 传入整个 message
message.content = summarized;  // summarized 已经是正确格式
```

**阶段 4**（继续摘要，Lines 1310-1313）：同阶段 2

**阶段 6**（最终修剪，Lines 1344-1349）：同阶段 1

---

## 预期效果

### ✅ 修复后应该看到：
1. **不再出现** `400 "Improperly formed request"` 错误
2. **看到修剪日志**：
   ```
   [Kiro Auto-Pruning] Token usage: 165234/200000 (83%) - Triggering pruning
   [Kiro Pruning] Initial state: 25 messages, 169530 tokens (limit: 200000)
   [Kiro Pruning] After summarizing old messages: 25 messages, 157823 tokens
   [Kiro Auto-Pruning] Completed: 157823/200000 (79%)
   ```
3. **长对话可以正常进行**，不会因为格式错误而失败
4. **Providers 逐渐恢复健康**（不再有格式错误）

---

## 部署步骤

### 1. 上传修复后的文件
```bash
scp "D:\project\2api\AIClient-2-API-main\src\claude\claude-kiro.js" root@34.96.206.12:/home/beidezhuanshuxiaomugou/a2a/src/claude/
```

### 2. 重启服务
```bash
ssh root@34.96.206.12 "cd /home/beidezhuanshuxiaomugou/a2a && pm2 restart kiro2api"
```

### 3. 验证部署
```bash
# 检查修复代码是否存在
ssh root@34.96.206.12 "grep -n '⚠️ 保持原始格式' /home/beidezhuanshuxiaomugou/a2a/src/claude/claude-kiro.js"

# 查看日志（应该看到修剪日志，而不是 400 错误）
ssh root@34.96.206.12 "pm2 logs kiro2api --lines 50 --nostream"
```

---

## 技术细节

### 为什么会出现这个问题？
1. OpenAI/Claude API 的 message.content 可以是：
   - **字符串**：`"Hello"`
   - **数组**：`[{ type: 'text', text: 'Hello' }, { type: 'image', ... }]`

2. 原始代码把数组格式改成字符串，破坏了格式一致性

3. Kiro API 在验证请求时发现格式不一致，返回 400 错误

### Kiro 官方客户端是怎么做的？
从 `D:\Users\Kangnaixi\AppData\Local\Programs\Kiro\resources\app\extensions\kiro.kiro-agent\dist\extension.js` 分析：

- Kiro 官方的 `summarize()` 函数（lines 161275-1280）确实只返回字符串
- **但** Kiro 官方客户端的消息格式是统一的（都是字符串），所以不会有问题
- 我们的实现需要兼容 OpenAI 格式（既有字符串又有数组），所以需要保持格式一致

---

## 修改文件
- `src/claude/claude-kiro.js`
  - Lines 1167-1191: `summarizeMessage()` 方法
  - Lines 1205-1212: `pruneChatHistory()` 深拷贝
  - Lines 1252-1257: 阶段 1 格式保持
  - Lines 1272-1275: 阶段 2 格式保持
  - Lines 1310-1313: 阶段 4 格式保持
  - Lines 1344-1349: 阶段 6 格式保持

---

## 测试建议
1. 发送一个长对话（20+ 轮）
2. 观察是否触发修剪（查找 `[Kiro Auto-Pruning]` 日志）
3. 验证不再出现 400 "Improperly formed request" 错误
4. 确认 providers 状态逐渐恢复健康
