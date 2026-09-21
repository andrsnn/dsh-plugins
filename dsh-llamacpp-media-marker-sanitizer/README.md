# dsh-llamacpp-media-marker-sanitizer

DSH tool output can contain llama.cpp's private multimodal sentinel when an
agent reads the raw `/props` endpoint. Replaying that sentinel as ordinary text
makes llama.cpp expect an attachment and reject the next request with
`Failed to tokenize prompt`.

This plugin transforms only text blocks in completed tool results. Literal
`<__media_...__>` sentinels become a harmless explanatory placeholder. Native
image/audio content blocks and canonical tool values are not changed.
