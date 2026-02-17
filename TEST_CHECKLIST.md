# ForceLocal Mode - 测试清单

> 测试前准备：
> 1. 确保 VS Code 已通过 Remote SSH 连接到远程服务器
> 2. 确保 `claudeCode.forceLocal: true` 已设置
> 3. 执行 `Developer: Reload Window` 重新加载窗口
> 4. 打开 Claude Code 面板

---

## 1. 基础功能

### 1.1 插件激活
- [ ] Claude Code 面板能正常打开
- [ ] 输出日志中出现 `forceLocal: registered remote tools on in-process MCP server. Tools: 6`
- [ ] 输出日志中出现 `forceLocal: CLI will run locally, built-in file tools disabled, MCP hooks added`

**如何查看日志**: `View → Output → 选择 "Claude Code"`

---

### 1.2 读取文件 (read_file)
**测试**: 让 Claude 读取一个远程文件

```
请读取 /root/some_file.txt 的内容
```
（替换为远程服务器上存在的文件路径）

- [ ] 文件内容正确返回
- [ ] 中文内容不乱码
- [ ] 大文件（>1000行）能正常读取

---

### 1.3 写入文件 (write_file)
**测试**: 让 Claude 创建一个新文件

```
在远程服务器上创建文件 /tmp/claude_test.txt，内容为 "Hello from forceLocal mode"
```

- [ ] 文件成功创建
- [ ] 是否弹出 diff 窗口显示变更？
- [ ] 手动验证文件内容：在远程终端运行 `cat /tmp/claude_test.txt`

---

### 1.4 编辑文件 (edit_file)
**测试**: 让 Claude 修改刚创建的文件

```
把 /tmp/claude_test.txt 中的 "Hello" 替换为 "Hi"
```

- [ ] 编辑成功
- [ ] 是否弹出 diff 窗口显示变更？
- [ ] 手动验证：`cat /tmp/claude_test.txt` 应显示 "Hi from forceLocal mode"

---

### 1.5 文件搜索 (glob)
**测试**: 让 Claude 搜索文件

```
在远程工作区中搜索所有 .py 文件
```
（或替换为远程服务器上有的文件类型）

- [ ] 返回文件列表
- [ ] 路径是远程路径（不是本地路径如 ~/.claude/remote/...）

---

### 1.6 内容搜索 (grep)
**测试**: 让 Claude 搜索文件内容

```
在远程工作区中搜索包含 "import" 的文件
```

- [ ] 返回匹配结果（文件名 + 行号 + 内容）
- [ ] **不再出现 SSH Permission Denied 错误**
- [ ] 搜索速度可接受（< 10秒）

---

### 1.7 执行命令 (bash)
**测试**: 让 Claude 在远程执行命令

```
在远程服务器上运行 ls -la /tmp/
```

- [ ] 命令输出正确返回
- [ ] **不再出现 SSH Permission Denied 错误**
- [ ] 再测试一个更复杂的命令：`请在远程运行 python3 --version && pip list | head -10`

---

## 2. 交互体验

### 2.1 工具调用显示
- [ ] 工具调用显示为 `Claude-vscode [read_file]` 格式（而非原生 `Read(file)` 格式）
- [ ] 这是已知限制，记录实际看到的格式：____________

### 2.2 Diff 窗口
在 1.3 和 1.4 测试时观察：
- [ ] 编辑后是否自动打开 diff 窗口？
- [ ] diff 窗口中左侧是旧内容，右侧是新内容？
- [ ] diff 窗口标题格式正确（如 `filename.txt (edit)`）？

### 2.3 多次编辑
**测试**: 让 Claude 连续做多次编辑

```
请在 /tmp/claude_test.txt 末尾添加三行：
Line 2
Line 3
Line 4
```

- [ ] 每次编辑都成功
- [ ] 没有出现 "old_string not found" 错误

---

## 3. 诊断反馈（如果远程有语言服务器）

### 3.1 TypeScript/Python 诊断
**测试**（需要远程有 TypeScript 或 Python 语言服务器）:

```
请在某个 .ts 或 .py 文件中故意引入一个语法错误
```

- [ ] 编辑后是否有诊断反馈出现在输出日志中？
- [ ] 日志中是否出现 `[DiagnosticTracking]` 相关信息？

---

## 4. 边界情况

### 4.1 不存在的文件
```
请读取 /nonexistent/path/file.txt
```
- [ ] 返回友好的错误信息（而非崩溃）

### 4.2 大文件搜索
```
在远程工作区中搜索包含 "def " 的所有 Python 文件
```
- [ ] 不超时
- [ ] 结果被截断而非内存溢出

### 4.3 长时间命令
```
在远程运行 sleep 3 && echo done
```
- [ ] 等待完成后返回 "done"
- [ ] 没有提前超时

### 4.4 带特殊字符的命令
```
在远程运行 echo "hello world" && echo 'single quotes' && echo $HOME
```
- [ ] 所有输出正确
- [ ] 特殊字符和变量被正确处理

---

## 5. 错误恢复

### 5.1 权限不足
```
请读取 /etc/shadow
```
- [ ] 返回权限错误（而非崩溃）

### 5.2 命令失败
```
在远程运行 ls /nonexistent_dir
```
- [ ] 返回错误信息和非零退出码

---

## 反馈模板

完成测试后，请用以下格式反馈：

```
1.1 激活: ✅ / ❌ (备注)
1.2 读取: ✅ / ❌ (备注)
1.3 写入: ✅ / ❌ (备注)
1.4 编辑: ✅ / ❌ (备注)
1.5 glob: ✅ / ❌ (备注)
1.6 grep: ✅ / ❌ (备注)
1.7 bash: ✅ / ❌ (备注)
2.1 工具显示: (描述看到的格式)
2.2 diff窗口: ✅ / ❌ (备注)
2.3 多次编辑: ✅ / ❌ (备注)
3.1 诊断: ✅ / ❌ / 跳过 (备注)
4.1 不存在文件: ✅ / ❌
4.2 大文件搜索: ✅ / ❌
4.3 长命令: ✅ / ❌
4.4 特殊字符: ✅ / ❌
5.1 权限不足: ✅ / ❌
5.2 命令失败: ✅ / ❌
```
