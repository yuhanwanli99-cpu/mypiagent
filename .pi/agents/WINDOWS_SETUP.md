# Windows 环境执行约定

所有代理（架构师、开发者、测试工程师）运行在 Git Bash 环境。

## 🚨 关键：路径与 Shell 不可混搭

**pi 的 `bash` 工具本身就运行在 Git Bash 中。** 绝大多数命令可以直接执行，无需任何前缀。

## 命令执行规范（按优先级）

### 方式 1：直接执行（默认，推荐）

适用于 99% 的场景。bash 工具就是 Git Bash，直接用 POSIX 路径：

```bash
# ✅ 默认方式 — 直接运行 + POSIX 路径
pip install -r requirements.txt
npm install
python /f/piagent/src/main.py
pytest /f/piagent/tests/
npm test
python --version
```

### 方式 2：cmd /c 包装（仅 .bat/.cmd 或必须走 CMD 时）

**当且仅当** 命令文件是 `.bat` / `.cmd` 后缀，或明确需要 CMD 环境变量时，才用 `cmd /c`。
**此时必须使用 Windows 风格路径**，因为 CMD 不理解 POSIX 路径：

```bash
# ✅ cmd /c + Windows 路径（注意路径格式必须匹配 shell）
cmd /c "python F:\piagent\src\main.py"
cmd /c "pytest F:\piagent\tests\"
cmd /c "run.bat"

# ❌ 严禁混搭 — CMD 无法解析 POSIX 路径
# cmd /c "python /f/piagent/src/main.py"   ← 必然报错！
```

## 路径速查表

| 上下文 | 路径格式 | 示例 |
| -------- | --------- | ------ |
| bash 工具（默认） | POSIX | `/f/piagent/src/main.py` |
| cmd /c 内部 | Windows | `F:\piagent\src\main.py` |
| read/write/edit 工具 | POSIX | `/f/piagent/src/main.py` |
| 文件内容引用 | POSIX | `src/main.py` |

## 禁止组合（必然报错）

```bash
# ❌ cmd /c + POSIX 路径 → CMD 报 "系统找不到指定的路径"
cmd /c "python /f/piagent/src/main.py"

# ❌ bash 直接执行 + Windows 反斜杠路径 → bash 可能误解义
# python F:\piagent\src\main.py   ← \p 被解释为转义
```
