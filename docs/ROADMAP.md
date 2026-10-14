# Roadmap / ideas

Ordered by expected value. Measurements come from `docs/OPENCODE-INTEGRATION.md`.

## 1. Emissão de Tools nativas do OpenCode (Tool Cards / `providerExecuted: true`)

Hoje os passos de ferramentas executados internamente pelo `agy` (`run_command`, `view_file`, etc.)
são convertidos e emitidos na stream como blocos de `reasoning` (`▸ run_command ...`).
- **Problema**: O OpenCode não renderiza como os tool cards nativos nem aplica os formatters
  visuais padrão da UI do OpenCode.
- **Solução pesquisada**: Como verificado em `docs/PERMISSIONS-AND-EFFORT.md` (F4), o adapter do
  OpenCode 2.x suporta partes de stream `tool-call` e `tool-result` com a flag `providerExecuted: true`.
- **Implementação**: No evento `onToolStep`, mapear `run_command` -> tool card `bash` / `run_command`,
  `view_file` -> tool card de leitura, fechando com `tool-result` quando `state === "DONE"`.

## 2. Diálogo interativo e perguntas do usuário (`ask_question` / `question`)

No modo headless (`stream-json`), o `agy` não exibe seu modal interativo (e foi adicionada nota
para forçar perguntas em texto puro).
- **Problema**: Ferramentas e comandos do OpenCode que dependem de diálogos ou confirmações
  (como a ferramenta nativa `question` do OpenCode) não interagem com o modal nativo do TUI.
- **Solução / Caminhos**:
  1. *Texto Direto Estruturado*: Orientar e padronizar o modelo para retornar perguntas com
     opções claras em texto markdown (como já atenuado pelo bridge note).
  2. *PreToolUse Hook / Interceptador no agy*: Usar o sistema de Lifecycle Hooks do agy (`.agents/hooks.json`
     ou plugin `PreToolUse`) para interceptar tool calls ou requisições interativas e conectar via
     bridge ou socket Unix com o OpenCode.
  3. *Bridge MCP*: Expor um servidor MCP local que sirva como canal de interação bidirecional
     com o OpenCode.

## 3. Seleção de Reasoning Effort via UI do OpenCode (`ctrl+t` / variants)

Hoje as variantes de esforço estão fixadas no ID do modelo (`gemini-4-argon-high`, etc.).
- **Solução pesquisada**: O OpenCode injeta a variante escolhida via `ctrl+t` / `/variants`
  em `callOpts.providerOptions?.agy?.effort`.
- **Implementação**: Registrar no catálogo famílias base (ex: `gemini-4-argon`, `claude-sonnet-5-5`)
  com variantes (`low`, `medium`, `high`), e dinamicamente resolver o ID completo do agy
  ou passar `--effort <effort>`. Manter retrocompatibilidade com IDs completos.

## 4. MCP Servers e Tools Externas do OpenCode para o agy

O OpenCode possui configuração de MCP (`opencode.json` -> `mcpServers`), mas o `agy` consome
MCP via `~/.gemini/config/mcp_config.json` ou plugins em `.agents/plugins/`.
- **Solução pesquisada**: Criar sincronização ou bridge automática onde o plugin/bridge
  do OpenCode lê as configurações de MCP do OpenCode e as reflete no `mcp_config.json` do agy
  ou via flag `--add-dir`/plugin dinâmico. Assim, ferramentas personalizadas configuradas no
  OpenCode ficam automaticamente disponíveis dentro do processo agy.

## 5. Persistent agy process per session (maior ganho de latência)

`--input-format stream-json` processa um turno por linha NDJSON e continua ativo enquanto
o stdin estiver aberto. Reduz o início de turnos subsequentes de ~3-5s para ~130ms.
- Pool gerenciado por sessão do OpenCode;
- Respawn em troca de modelo, abort/cancelamento ou timeout;
- Idle kill após tempo configurável.

## 6. Detecção de prompts de compactação e helpers (Compaction / Summary)

Hoje a geração de título é detectada e executada de forma efêmera sem sujar a conversa do agy.
Fazer o mesmo para o prompt de compactação/resumo do OpenCode 2.x, evitando persistir turnos
de resumo interno dentro da árvore de contexto principal do agy.

## 7. Mapeamento de status e erros agy para finish reasons do OpenCode

Mapear status do agy (`ERROR`, cancelamento, limites de contexto) para `error` / `length` / `other`
em `finishReason.unified`, garantindo mensagens ricas em stream parts do tipo `error`.

## 8. Sincronização automática do catálogo de modelos

Script ou comando de sincronização que lê `agy models` e gera o bloco compatível de configuração
do OpenCode, alertando sobre novos modelos ou descontinuações.

## 9. Suporte a imagens e arquivos anexados (multimodal)

Investigar o suporte a partes multimodais no array de `content` do stream-json do agy,
permitindo envio de imagens anexadas no OpenCode sem descartá-las com aviso.
