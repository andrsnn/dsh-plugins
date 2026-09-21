# dsh-chat-attachments

Adds an always-visible paperclip to DSH 0.1.1's composer.

- PNG, JPEG, WebP, and GIF use DSH's native durable image-draft pipeline and are sent to the model as images.
- Other files are uploaded to `<workspace>/.dsh-uploads/` and a readable absolute path is appended to the draft. The model can inspect that path with its normal filesystem tools.
- Mixed selections work. The default limits are eight files per selection and 50 MiB per general file.
- The host derives the destination from the live or attached restored session. The browser cannot choose an arbitrary server path, and subagent-session uploads are refused.

This is a compatibility bridge for DSH versions before native general-file blocks (added upstream in 0.1.5-rc.1). General files are workspace paths, not native historical file blocks; images are native attachments.

Install into the web profile:

```powershell
dsh plugin --profile web add G:\llmhub\integrations\dsh\dsh-chat-attachments
```
