# media 内容素材

这里放小单设备用到的内容素材，由控制塔读取和管理。

## stories/ 原创故事

- 本项目原创的儿童故事，适合 3-8 岁，不是任何已有作品的改编或转述。版权许可与本仓库一致（MIT）。
- 每个故事一个 `.md` 文件：YAML 头信息（`id`、`title`、`summary`、`age`、`tags`、`minutes`、`voice_instruction`）加正文。
- 正文用短句写，方便设备小屏逐句显示字幕、TTS 逐句朗读。所有文字都能用 GB2312 编码，标点只用常见中文标点。
- 仓库里不存音频。音频以后由控制塔调用 Qwen TTS 生成，`voice_instruction` 是给 TTS 的语气提示。

## vocab/ 英语词表

- `starter.json`：启蒙英语核心词，约 300 个单词，按主题分组，适合 4-9 岁。
- 词表的选词、中文释义、例句和例句翻译都是本项目原创编写，许可同样是 MIT。
- 字段：`word`（小写英文）、`meaning`（中文释义）、`topic`（主题）、`example`（英文例句）、`example_cn`（例句翻译）、`level`（难度 1-3）。

## music/ 音乐

由另一项任务维护。每首曲目的来源和许可证见该目录下的 `LICENSES.md`。
