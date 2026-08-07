// YandBox.js - AI-powered HTML page generator with real-time progress and version history
import http from 'http';
import { readFileSync, existsSync, writeFileSync, watch, unlinkSync } from 'fs';
import path from 'path';
import { URL } from 'url';
import readline from 'readline';
import EasyAI from '/usr/local/etc/EasyAI/EasyAI.js';

class YandBox {
    
    constructor(config = {}) {
        this.port = config.port || 3000;
        this.tokenPath = path.join(process.cwd(), 'yandbox-config.json');
        this.logPath = path.join(process.cwd(), 'yandbox-log.json');
        this.versionsPath = path.join(process.cwd(), 'yandbox-versions.json');
        
        const saved = this.loadConfig();
        
        // Migrate old format if needed
        if (!saved.configs && saved.keys) {
            saved.configs = {};
            for (const name in saved.keys) {
                const entry = saved.keys[name];
                saved.configs[name] = {
                    provider: entry.provider || (entry.token && entry.token.startsWith('sk-') ? 'deepseek' : 'deepinfra'),
                    token: entry.token || null,
                    model: entry.model || null,
                    serverUrl: null,
                    serverPort: null,
                    serverToken: null
                };
            }
            delete saved.keys;
            saved.activeConfig = saved.activeConfig || Object.keys(saved.configs)[0] || null;
            this.saveConfigData(saved);
        }
        
        this.configs = saved.configs || {};
        this.activeConfigName = config.activeConfig || saved.activeConfig || null;
        this.totalCost = saved.totalCost || 0;
        this.sessionCost = 0;
        this.sessionContinueCost = 0;            // NEW: track cost from continuation attempts
        this.requests = saved.requests || [];
        this.versions = [];
        this.currentGeneration = null;
        this._originalFetch = null;
        
        // Progress tracking state
        this._progressState = {
            lastPercent: 0,
            lastUpdateTime: 0,
            isActive: false
        };
        
        // Apply active configuration
        this._applyActiveConfig();
        
        // Set default model if none
        if (!this.model && this.provider) {
            if (this.provider === 'deepseek') {
                this.model = 'deepseek-v4-flash';
            } else if (this.provider === 'deepinfra') {
                this.model = 'meta-llama/Meta-Llama-3.1-8B-Instruct';
            }
        }
        
        this.saveConfig();
        this.loadVersions();
        
        // Instantiate EasyAI based on provider
        if (this.provider) {
            const aiConfig = {};
            
            if (this.provider === 'deepseek') {
                aiConfig.deepseek_token = this.token;
                aiConfig.deepseek_model = this.model;
            } else if (this.provider === 'deepinfra') {
                aiConfig.deepinfra_token = this.token;
                aiConfig.deepinfra_model = this.model;
            } else if (this.provider === 'local') {
                aiConfig.server_url = this.serverUrl || 'http://localhost';
                aiConfig.server_port = this.serverPort || 4000;
                aiConfig.server_token = this.serverToken || '';
            }
            
            this.AI = new EasyAI(aiConfig);
        } else {
            this.AI = null;
        }
        
        this.sseClients = new Set();
        this.requestCount = 0;
        this.startHUD();
        
        this.ensureBaseFiles().then(() => {
            this.initServer();
        }).catch(err => {
            console.error('Failed to initialize YandBox:', err);
            process.exit(1);
        });
    }

    _applyActiveConfig() {
        const cfg = this.configs[this.activeConfigName] || {};
        this.provider = cfg.provider || null;
        this.token = cfg.token || null;
        this.model = cfg.model || null;
        this.serverUrl = cfg.serverUrl || null;
        this.serverPort = cfg.serverPort || 4000;
        this.serverToken = cfg.serverToken || null;
    }

    loadConfig() {
        try {
            if (existsSync(this.tokenPath)) {
                return JSON.parse(readFileSync(this.tokenPath, 'utf8'));
            }
        } catch (err) {}
        return {};
    }

    saveConfig() {
        this.saveConfigData({
            configs: this.configs,
            activeConfig: this.activeConfigName,
            totalCost: this.totalCost,
            requests: this.requests.slice(-50)
        });
    }

    saveConfigData(data) {
        writeFileSync(this.tokenPath, JSON.stringify(data, null, 2));
        
        const log = {
            totalCost: data.totalCost || this.totalCost,
            requests: (data.requests || this.requests).slice(-100)
        };
        writeFileSync(this.logPath, JSON.stringify(log, null, 2));
    }

    loadVersions() {
        try {
            if (existsSync(this.versionsPath)) {
                this.versions = JSON.parse(readFileSync(this.versionsPath, 'utf8'));
            }
        } catch (err) {
            this.versions = [];
        }
    }

    saveVersions() {
        if (this.versions.length > 10) {
            this.versions = this.versions.slice(-10);
        }
        writeFileSync(this.versionsPath, JSON.stringify(this.versions, null, 2));
    }

    startHUD() {
        const updateHUD = () => {
            console.clear();
            const w = 50;
            const top = '╔' + '═'.repeat(w - 2) + '╗';
            const mid = '╠' + '═'.repeat(w - 2) + '╣';
            const bot = '╚' + '═'.repeat(w - 2) + '╝';
            
            console.log('\x1b[36m' + top + '\x1b[0m');
            console.log('\x1b[36m║\x1b[0m' + '  \x1b[1mYandBox AI Page Generator\x1b[0m' + ' '.repeat(w - 28) + '\x1b[36m║\x1b[0m');
            console.log('\x1b[36m' + mid + '\x1b[0m');
            
            const providerDisplay = '\x1b[33m' + (this.provider || 'none').toUpperCase() + '\x1b[0m';
            let modelDisplay;
            
            if (this.provider === 'local') {
                const urlStr = this.serverUrl ? `${this.serverUrl}:${this.serverPort}` : 'localhost:4000';
                modelDisplay = '\x1b[32m' + (this.model || urlStr) + '\x1b[0m';
            } else {
                const modelStr = this.model || 'none';
                modelDisplay = '\x1b[32m' + (modelStr.length > 30 ? modelStr.substring(0, 27) + '...' : modelStr) + '\x1b[0m';
            }
            
            const lines = [
                ['Provider', providerDisplay],
                ['Model', modelDisplay],
                ['Port', '\x1b[34m' + this.port + '\x1b[0m'],
                ['Requests', '\x1b[35m' + this.requestCount + '\x1b[0m'],
                ['Session Cost', '\x1b[31m$' + this.sessionCost.toFixed(8) + '\x1b[0m'],
            ];
            
            // Show continue cost separately if non‑zero
            if (this.sessionContinueCost > 0) {
                lines.push(['Continue Cost', '\x1b[31m$' + this.sessionContinueCost.toFixed(8) + '\x1b[0m']);
            }
            
            lines.push(['Total Cost', '\x1b[31m$' + this.totalCost.toFixed(8) + '\x1b[0m']);
            lines.push(['Generation', this.currentGeneration ? '\x1b[33mACTIVE\x1b[0m' : '\x1b[90midle\x1b[0m']);
            
            if (this.provider === 'local') {
                lines.splice(2, 0, ['Server', '\x1b[34m' + (this.serverUrl || 'localhost') + ':' + (this.serverPort || 4000) + '\x1b[0m']);
            }
            
            lines.forEach(([label, value]) => {
                const line = ` ${label}: ${value}`;
                const cleanLine = line.replace(/\x1b\[\d+m/g, '');
                const padding = w - cleanLine.length - 2;
                console.log('\x1b[36m║\x1b[0m' + line + ' '.repeat(Math.max(0, padding)) + '\x1b[36m║\x1b[0m');
            });
            
            console.log('\x1b[36m' + mid + '\x1b[0m');
            
            const lastRequests = this.requests.slice(-5);
            if (lastRequests.length > 0) {
                lastRequests.forEach(req => {
                    const modelShort = (req.model || 'unknown').substring(0, 22).padEnd(22);
                    const cost = '$' + (req.cost || 0).toFixed(8);
                    const tokens = String(req.tokens || 0).padEnd(5) + 't';
                    const line = ` \x1b[90m${modelShort}\x1b[0m \x1b[31m${cost}\x1b[0m \x1b[33m${tokens}\x1b[0m`;
                    const cleanLine = line.replace(/\x1b\[\d+m/g, '');
                    const padding = w - cleanLine.length - 2;
                    console.log('\x1b[36m║\x1b[0m' + line + ' '.repeat(Math.max(0, padding)) + '\x1b[36m║\x1b[0m');
                });
            } else {
                const empty = '  No requests yet...';
                console.log('\x1b[36m║\x1b[0m' + empty + ' '.repeat(w - empty.length - 2) + '\x1b[36m║\x1b[0m');
            }
            
            console.log('\x1b[36m' + bot + '\x1b[0m');
        };
        
        updateHUD();
        this.hudInterval = setInterval(updateHUD, 1000);
    }

    async ensureBaseFiles() {
        const files = ['index.html', 'chat.html', 'main.html'];
        const rootDir = process.cwd();

        for (const file of files) {
            const rootPath = path.join(rootDir, file);
            if (!existsSync(rootPath)) {
                const baseName = path.basename(file, '.html');
                const jsPath = path.join(rootDir, '._', `${baseName}.js`);
                if (existsSync(jsPath)) {
                    try {
                        const module = await import(`file://${jsPath}`);
                        const htmlContent = module.default;
                        writeFileSync(rootPath, htmlContent, 'utf8');
                    } catch (err) {
                        console.error(`Failed to generate ${file}:`, err);
                        throw err;
                    }
                }
            }
        }
    }

    initServer() {
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const pathname = url.pathname;
            
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            // SSE endpoint
            if (pathname === '/events') {
                this.handleSSE(req, res);
                return;
            }

            // Chat endpoint
            if (pathname === '/chat' && req.method === 'POST') {
                this.handleChatMessage(req, res);
                return;
            }

            // Cancel current generation
            if (pathname === '/cancel-generation' && req.method === 'POST') {
                this.cancelGeneration();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                return;
            }

            // Version history list
            if (pathname === '/api/versions' && req.method === 'GET') {
                const list = this.versions.map((v, i) => ({
                    index: i,
                    timestamp: v.timestamp,
                    request: v.request.substring(0, 50) + '...',
                    size: v.html.length
                }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(list));
                return;
            }

            // Revert to a specific version
            if (pathname === '/api/revert' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const { index } = JSON.parse(body);
                        await this.revertToVersion(index);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err.message }));
                    }
                });
                return;
            }

            // Test connection endpoint
            if (pathname === '/api/test-connection' && req.method === 'GET') {
                this.handleTestConnection(req, res);
                return;
            }

            // Serve static files
            if (pathname === '/') {
                try {
                    const indexHtml = readFileSync('./index.html').toString();
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(indexHtml);
                } catch (err) {
                    res.writeHead(500);
                    res.end('Error loading index.html');
                }
                return;
            } else {
                const filePath = path.join(process.cwd(), pathname);
                if (existsSync(filePath)) {
                    try {
                        const fileContent = readFileSync(filePath).toString();
                        const contentType = pathname.endsWith('.html') ? 'text/html' : 'text/plain';
                        res.writeHead(200, { 'Content-Type': contentType });
                        res.end(fileContent);
                    } catch (err) {
                        res.writeHead(500);
                        res.end('Error loading file');
                    }
                } else {
                    res.writeHead(404);
                    res.end('Not found');
                }
            }
        });

        // Watch main.html for external changes
        try {
            watch('./main.html', (eventType, filename) => {
                if (eventType === 'change' && !this.currentGeneration) {
                    try {
                        const updatedHtml = readFileSync('./main.html', 'utf8');
                        this.broadcastSSE({ type: 'update-html', html: updatedHtml });
                    } catch (err) {}
                }
            });
        } catch (err) {}

        server.listen(this.port, () => {});
    }

    handleSSE(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        res.write('data: {"type":"connected"}\n\n');
        this.sseClients.add(res);

        req.on('close', () => {
            this.sseClients.delete(res);
        });
    }

    broadcastSSE(data) {
        const message = `data: ${JSON.stringify(data)}\n\n`;
        this.sseClients.forEach(client => {
            client.write(message);
        });
    }

    async handleTestConnection(req, res) {
        if (!this.AI) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                connected: false, 
                error: 'No AI instance configured',
                provider: this.provider
            }));
            return;
        }
        
        try {
            const testMessages = [
                { role: 'user', content: 'Say "connected" and nothing else.' }
            ];
            
            const result = await this.AI.Chat(testMessages, { stream: false });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                connected: true,
                provider: this.provider,
                serverUrl: this.serverUrl,
                serverPort: this.serverPort,
                response: result?.full_text || result?.choices?.[0]?.message?.content || 'Response received'
            }));
        } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                connected: false,
                error: err.message,
                provider: this.provider,
                serverUrl: this.serverUrl,
                serverPort: this.serverPort
            }));
        }
    }

    // ---------- NEW: HTML completeness checker ----------
    /**
     * Check if the generated HTML is structurally complete.
     * Uses a stack-based parser ignoring void/self-closing elements,
     * script/style blocks and comments.
     */
    _isHtmlComplete(html) {
        // Remove script and style blocks
        let clean = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        clean = clean.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
        // Remove HTML comments
        clean = clean.replace(/<!--[\s\S]*?-->/g, '');
        
        const voidElements = new Set([
            'area','base','br','col','embed','hr','img','input',
            'link','meta','param','source','track','wbr','command',
            'keygen','menuitem'
        ]);
        
        const tagRegex = /<\/?([a-zA-Z0-9]+)(\s[^>]*)?>/g;
        const stack = [];
        let match;
        
        while ((match = tagRegex.exec(clean)) !== null) {
            const fullTag = match[0];
            const tagName = match[1].toLowerCase();
            const isClosing = fullTag.startsWith('</');
            const isSelfClosing = fullTag.endsWith('/>');
            
            if (isClosing) {
                if (stack.length === 0) return false;
                const last = stack.pop();
                if (last !== tagName) return false;
            } else if (voidElements.has(tagName) || isSelfClosing) {
                // void or self-closing, ignore
            } else {
                stack.push(tagName);
            }
        }
        
        return stack.length === 0;
    }

    // ---------- NEW: Core generation method (used by main & continues) ----------
    /**
     * Runs a single AI chat completion and returns the generated HTML buffer
     * plus metadata for cost calculation. Handles streaming, progress updates,
     * and works within the existing abort controller.
     */
    async _callAIForGeneration(messages, chatRes, estimatedOutputLength) {
        const generationStartTime = Date.now();
        let generatedBuffer = '';
        const htmlStructure = { tags: 0, closingTags: 0 };
        
        const chatConfig = {
            stream: true,
            tokenCallback: (data) => {
                let token = null;
                if (data.stream?.content) {
                    token = data.stream.content;
                } else if (data.content) {
                    token = data.content;
                } else if (data.choices?.[0]?.delta?.content) {
                    token = data.choices[0].delta.content;
                } else if (data.choices?.[0]?.text) {
                    token = data.choices[0].text;
                } else if (typeof data === 'string') {
                    token = data;
                }
                
                if (token) {
                    generatedBuffer += token;
                    if (token.includes('<')) htmlStructure.tags++;
                    if (token.includes('</')) htmlStructure.closingTags++;
                    
                    const elapsedSeconds = (Date.now() - generationStartTime) / 1000;
                    const percent = this._calculateProgress(
                        generatedBuffer.length, 
                        estimatedOutputLength, 
                        htmlStructure, 
                        elapsedSeconds
                    );
                    this._sendProgress(percent);
                }
            }
        };

        if (this.provider === 'deepseek') chatConfig.deepseek = true;
        else if (this.provider === 'deepinfra') chatConfig.deepinfra = true;

        const result = await this.AI.Chat(messages, chatConfig);

        // Extract buffer if streaming didn't capture (fallback)
        if (!generatedBuffer && result) {
            if (result.full_text) generatedBuffer = result.full_text;
            else if (result.choices?.[0]?.message?.content) generatedBuffer = result.choices[0].message.content;
            else if (typeof result === 'string') generatedBuffer = result;
        }

        return {
            buffer: generatedBuffer || '',
            usage: result.metadata?.usage,
            model: result.metadata?.model || this.model
        };
    }

    // ---------- NEW: Centralised cost recording ----------
    /**
     * Record a single generation request (normal or continuation) and update
     * session/total/continue cost counters.
     */
    _recordRequest(usage, model, isContinue = false) {
        if (!usage) {
            // Fallback for providers that don't return usage (e.g. local)
            this.requestCount++;
            return;
        }

        const tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
        let cost = 0;
        
        // Prefer estimated_cost (works for all providers)
        if (usage.estimated_cost !== undefined && usage.estimated_cost !== null) {
            cost = usage.estimated_cost;
        } else if (this.provider === 'deepseek' && this.AI.DeepSeek) {
            cost = this.AI.DeepSeek._calculateCost(this.model, usage);
        } else if (this.provider === 'deepinfra' && this.AI.DeepInfra) {
            cost = this.AI.DeepInfra._calculateCost(this.model, usage);
        }
        
        if (tokens > 0 || cost > 0) {
            this.sessionCost += cost;
            this.totalCost += cost;
            if (isContinue) {
                this.sessionContinueCost += cost;
            }
            this.requests.push({
                model: model || this.model || this.provider,
                cost,
                tokens,
                time: new Date().toLocaleTimeString()
            });
        }
        this.requestCount++;
    }

    // Progress helpers (unchanged)
    _calculateProgress(generatedLength, estimatedTotal, structure, elapsedSeconds) {
        const charProgress = Math.min(80, (generatedLength / Math.max(estimatedTotal, 1)) * 100);
        let structureProgress = 0;
        if (structure.tags > 0) {
            const closingRatio = structure.closingTags / structure.tags;
            structureProgress = Math.min(10, closingRatio * 10);
        }
        const timeProgress = Math.min(5, elapsedSeconds * 1.5);
        return Math.min(95, Math.round(charProgress + structureProgress + timeProgress));
    }

    _sendProgress(percent, force = false) {
        const now = Date.now();
        const state = this._progressState;
        if (force || percent !== state.lastPercent || (now - state.lastUpdateTime) >= 250) {
            state.lastPercent = percent;
            state.lastUpdateTime = now;
            this.broadcastSSE({ type: 'progress', percent });
        }
    }

    _resetProgress() {
        this._progressState = {
            lastPercent: 0,
            lastUpdateTime: 0,
            isActive: false
        };
    }

    getLoadingTemplate(progressPercent = 0) {
        return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Generating...</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #1e1e1e; color: #ccc; display: flex; align-items: center; justify-content: center; height: 100vh; margin:0; }
  .container { text-align: center; max-width: 400px; width: 90%; }
  .progress-bar { width: 100%; height: 8px; background: #333; border-radius: 4px; overflow: hidden; margin: 20px 0; }
  .progress-fill { height: 100%; width: ${progressPercent}%; background: #0af; transition: width 0.3s ease; }
  .actions { display: flex; gap: 10px; justify-content: center; margin-top: 15px; }
  button, select { background: #2a2a2a; border: 1px solid #444; color: #ddd; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 14px; }
  button:hover { background: #3a3a3a; }
  select { min-width: 200px; }
  .status { font-size: 13px; color: #aaa; margin-top: 8px; min-height: 20px; }
</style>
</head>
<body>
<div class="container">
  <h2>⚡ Generating new page...</h2>
  <div class="progress-bar"><div class="progress-fill" id="fill"></div></div>
  <div class="status" id="status">Initializing...</div>
  <div class="actions">
    <button id="cancelBtn">✕ Cancel</button>
    <select id="versionSelect"><option value="">← Previous versions</option></select>
  </div>
</div>
<script>
  (function() {
    const fill = document.getElementById('fill');
    const status = document.getElementById('status');
    const cancelBtn = document.getElementById('cancelBtn');
    const versionSelect = document.getElementById('versionSelect');
    let eventSource = null;
    let progressReceived = false;
    
    fetch('/api/versions')
      .then(r => r.json())
      .then(versions => {
        versions.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.index;
          opt.textContent = v.timestamp + ' – ' + v.request;
          versionSelect.appendChild(opt);
        });
      })
      .catch(() => {});
    
    versionSelect.addEventListener('change', () => {
      if (versionSelect.value === '') return;
      cleanupSSE();
      fetch('/api/revert', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ index: parseInt(versionSelect.value) })
      }).catch(() => {});
    });
    
    cancelBtn.addEventListener('click', () => {
      cleanupSSE();
      fetch('/cancel-generation', { method: 'POST' }).catch(() => {});
    });
    
    function cleanupSSE() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    }
    
    function connectSSE() {
      cleanupSSE();
      
      eventSource = new EventSource('/events');
      
      eventSource.addEventListener('message', (e) => {
        try {
          const data = JSON.parse(e.data);
          
          if (data.type === 'progress') {
            const p = data.percent || 0;
            fill.style.width = p + '%';
            status.textContent = p + '%';
            progressReceived = true;
          } else if (data.type === 'connected') {
            if (!progressReceived) {
              status.textContent = 'Connected...';
            }
          } else if (data.type === 'update-html') {
            cleanupSSE();
          }
        } catch(ex) {
          console.error('SSE parse error:', ex);
        }
      });
      
      eventSource.addEventListener('error', () => {
        status.textContent = 'Connection lost, reconnecting...';
        setTimeout(() => {
          if (eventSource) {
            connectSSE();
          }
        }, 1000);
      });
    }
    
    connectSSE();
    
    window.addEventListener('beforeunload', () => {
      cleanupSSE();
    });
  })();
</script>
</body>
</html>`;
    }

    abortGeneration() {
        const gen = this.currentGeneration;
        if (!gen) return;
        
        if (gen.abortController) {
            gen.abortController.abort();
        }
        
        if (gen.chatRes && !gen.chatRes.writableEnded) {
            gen.chatRes.write(`data: ${JSON.stringify({ type: 'token', token: '❌ Canceled.' })}\n\n`);
            gen.chatRes.write('data: {"type":"end"}\n\n');
            gen.chatRes.end();
        }
        
        if (this._originalFetch) {
            globalThis.fetch = this._originalFetch;
            this._originalFetch = null;
        }
        
        this._resetProgress();
        this.currentGeneration = null;
    }

    cancelGeneration() {
        const gen = this.currentGeneration;
        if (!gen) return;
        
        const backupHtml = gen.backupHtml;
        this.abortGeneration();
        
        writeFileSync('./main.html', backupHtml, 'utf8');
        this.broadcastSSE({ type: 'update-html', html: backupHtml });
    }

    async revertToVersion(index) {
        if (index < 0 || index >= this.versions.length) {
            throw new Error('Invalid version index');
        }
        this.abortGeneration();
        
        const versionHtml = this.versions[index].html;
        writeFileSync('./main.html', versionHtml, 'utf8');
        this.broadcastSSE({ type: 'update-html', html: versionHtml });
    }

    // ---------- MODIFIED: startGeneration with auto‑continue ----------
    async startGeneration(message, chatRes) {
        let currentHtml;
        try {
            currentHtml = readFileSync('./main.html', 'utf8');
        } catch (err) {
            currentHtml = '<html><body></body></html>';
        }
        
        const estimatedOutputLength = Math.max(currentHtml.length, 500);
        const abortController = new AbortController();
        this.currentGeneration = {
            abortController,
            backupHtml: currentHtml,
            chatRes,
            message
        };

        this._resetProgress();
        this._progressState.isActive = true;

        const loadingHtml = this.getLoadingTemplate(0);
        this.broadcastSSE({ type: 'update-html', html: loadingHtml });
        this._sendProgress(0, true);

        const originalFetch = globalThis.fetch;
        this._originalFetch = originalFetch;
        globalThis.fetch = (url, options) => {
            options = options || {};
            options.signal = abortController.signal;
            return originalFetch(url, options);
        };

        // Send initial chat message
        chatRes.write(`data: ${JSON.stringify({ type: 'token', token: '🔄 Generating new page...' })}\n\n`);

        const systemPrompt = `You are an expert web developer. The user wants to modify the HTML page. Provide the complete new HTML code. Output ONLY the raw HTML without markdown fences or explanations. Ensure the HTML is valid and includes all necessary tags.`;
        
        try {
            let finalHtml = '';
            let attempts = 0;
            const maxContinues = 12;   // default limit, can be made configurable later
            let baseHtml = currentHtml;
            
            // Helper to build messages for the current base HTML
            const buildMessages = (html) => [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Current HTML:\n${html}\n\nUser request: ${message}\n\nNew HTML:` }
            ];

            // First generation pass
            let passResult = await this._callAIForGeneration(
                buildMessages(baseHtml), chatRes, estimatedOutputLength
            );
            finalHtml = this._cleanHtml(passResult.buffer);
            this._recordRequest(passResult.usage, passResult.model, false);
            this._sendProgress(100, true);

            // Continue if HTML incomplete
            while (!this._isHtmlComplete(finalHtml) && attempts < maxContinues) {
                attempts++;
                // Inform user via chat SSE
                chatRes.write(`data: ${JSON.stringify({ type: 'token', token: `🔄 HTML incomplete – continuing (attempt ${attempts})...` })}\n\n`);
                
                baseHtml = finalHtml;   // use current (incomplete) result as new base
                passResult = await this._callAIForGeneration(
                    buildMessages(baseHtml), chatRes, estimatedOutputLength
                );
                finalHtml = this._cleanHtml(passResult.buffer);
                this._recordRequest(passResult.usage, passResult.model, true);  // mark as continue cost
                this._sendProgress(100, true);
            }

            // Final save & broadcast
            writeFileSync('./main.html', finalHtml, 'utf8');
            this.versions.push({
                timestamp: new Date().toLocaleString(),
                request: message,
                html: finalHtml
            });
            this.saveVersions();
            this.broadcastSSE({ type: 'update-html', html: finalHtml });

            // Success message
            if (!chatRes.writableEnded) {
                chatRes.write(`data: ${JSON.stringify({ type: 'token', token: '✅ Page updated successfully!' })}\n\n`);
                chatRes.write('data: {"type":"end"}\n\n');
                chatRes.end();
            }

            this.saveConfig();

        } catch (error) {
            if (error.name === 'AbortError') return;
            
            console.error('Generation error:', error);
            
            if (this.currentGeneration?.backupHtml) {
                writeFileSync('./main.html', this.currentGeneration.backupHtml, 'utf8');
                this.broadcastSSE({ type: 'update-html', html: this.currentGeneration.backupHtml });
            }
            
            if (!chatRes.writableEnded) {
                chatRes.write(`data: ${JSON.stringify({ type: 'token', token: '❌ Error: ' + error.message })}\n\n`);
                chatRes.write('data: {"type":"end"}\n\n');
                chatRes.end();
            }
        } finally {
            globalThis.fetch = this._originalFetch;
            this._originalFetch = null;
            this.currentGeneration = null;
            this._resetProgress();
        }
    }

    // Helper to strip markdown fences from generated text
    _cleanHtml(text) {
        let out = text.trim();
        out = out.replace(/^```html\s*\n?/i, '');
        out = out.replace(/\n?```\s*$/i, '');
        out = out.replace(/^```\s*\n?/i, '');
        out = out.replace(/\n?```\s*$/i, '');
        return out;
    }

    async handleChatMessage(req, res) {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const { message } = JSON.parse(body);
                
                if (!this.AI) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write('data: {"type":"token","token":"No AI provider configured. Please run: node YandBox.js keys"}\n\n');
                    res.write('data: {"type":"end"}\n\n');
                    res.end();
                    return;
                }

                if (this.currentGeneration) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ type: 'token', token: '⏳ A generation is already in progress. Please wait or cancel it.' })}\n\n`);
                    res.write('data: {"type":"end"}\n\n');
                    res.end();
                    return;
                }
                
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });

                this.startGeneration(message, res);

            } catch (error) {
                if (!res.headersSent) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: error.message }));
                } else {
                    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
                    res.end();
                }
            }
        });
    }
}

// ---------- CLI helpers (unchanged) ----------
async function question(q) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => rl.question(q, ans => {
        rl.close();
        resolve(ans);
    }));
}

function getModels(provider) {
    if (provider === 'local') return [];
    const dummyConfig = {};
    if (provider === 'deepseek') {
        dummyConfig.deepseek_token = 'dummy';
    } else {
        dummyConfig.deepinfra_token = 'dummy';
    }
    const tempAI = new EasyAI(dummyConfig);
    const api = provider === 'deepseek' ? tempAI.DeepSeek : tempAI.DeepInfra;
    return api.constructor.Models;
}

async function selectModel(provider) {
    if (provider === 'local') {
        const modelInput = await question('\n\x1b[36mModel name (optional, Enter to skip):\x1b[0m \x1b[90m> \x1b[0m');
        return modelInput.trim() || null;
    }
    
    const models = getModels(provider);
    const defaultModel = provider === 'deepseek' ? 'deepseek-v4-flash' : 'meta-llama/Meta-Llama-3.1-8B-Instruct';
    
    console.log(`\n\x1b[36mAvailable ${provider.toUpperCase()} models:\x1b[0m`);
    console.log(`  \x1b[90mDefault: \x1b[32m${defaultModel}\x1b[0m\n`);
    models.forEach((model, i) => {
        console.log(`  \x1b[33m${i + 1}\x1b[0m. \x1b[32m${model}\x1b[0m`);
    });

    const choice = await question('\n\x1b[36mSelect model (1-' + models.length + ') or Enter for default:\x1b[0m \x1b[90m> \x1b[0m');

    if (choice && !isNaN(choice) && choice >= 1 && choice <= models.length) {
        return models[choice - 1];
    }
    return defaultModel;
}

async function manageKeys() {
    const tokenPath = path.join(process.cwd(), 'yandbox-config.json');
    let saved = existsSync(tokenPath) ? JSON.parse(readFileSync(tokenPath, 'utf8')) : {};
    
    // Migrate old format
    if (!saved.configs && saved.keys) {
        saved.configs = {};
        for (const name in saved.keys) {
            const entry = saved.keys[name];
            saved.configs[name] = {
                provider: entry.provider || (entry.token && entry.token.startsWith('sk-') ? 'deepseek' : 'deepinfra'),
                token: entry.token || null,
                model: entry.model || null,
                serverUrl: null,
                serverPort: null,
                serverToken: null
            };
        }
        delete saved.keys;
        saved.activeConfig = saved.activeConfig || Object.keys(saved.configs)[0] || null;
        writeFileSync(tokenPath, JSON.stringify(saved, null, 2));
    }
    
    const configs = saved.configs || {};
    const activeConfig = saved.activeConfig || null;
    
    console.clear();
    const w = 50;
    const top = '\x1b[36m╔' + '═'.repeat(w - 2) + '╗\x1b[0m';
    const mid = '\x1b[36m╠' + '═'.repeat(w - 2) + '╣\x1b[0m';
    const bot = '\x1b[36m╚' + '═'.repeat(w - 2) + '╝\x1b[0m';
    
    console.log(top);
    console.log('\x1b[36m║\x1b[0m' + '  \x1b[1mConfiguration Manager\x1b[0m' + ' '.repeat(w - 25) + '\x1b[36m║\x1b[0m');
    console.log(mid);
    
    const configNames = Object.keys(configs);
    if (configNames.length > 0) {
        configNames.forEach((name) => {
            const cfg = configs[name];
            const isActive = name === activeConfig;
            const prefix = isActive ? '\x1b[32m*\x1b[0m' : ' ';
            
            let providerStr = cfg.provider.toUpperCase();
            let detailStr = '';
            
            if (cfg.provider === 'local') {
                const urlStr = cfg.serverUrl ? `${cfg.serverUrl}:${cfg.serverPort || 4000}` : 'localhost:4000';
                detailStr = `\x1b[90m${urlStr}\x1b[0m`;
            } else if (cfg.token) {
                const masked = cfg.token.substring(0, 8) + '...' + cfg.token.substring(cfg.token.length - 4);
                detailStr = `\x1b[90m${masked}\x1b[0m`;
            }
            
            const modelStr = (cfg.model || 'default').substring(0, 20);
            const line = ` ${prefix} ${name.padEnd(10)} ${providerStr.padEnd(10)} ${modelStr}`;
            const cleanLine = line.replace(/\x1b\[\d+m/g, '');
            console.log('\x1b[36m║\x1b[0m' + line + ' '.repeat(Math.max(0, w - cleanLine.length - 2)) + '\x1b[36m║\x1b[0m');
            
            if (detailStr) {
                const cleanDetail = detailStr.replace(/\x1b\[\d+m/g, '');
                console.log('\x1b[36m║\x1b[0m   ' + detailStr + ' '.repeat(Math.max(0, w - cleanDetail.length - 5)) + '\x1b[36m║\x1b[0m');
            }
        });
    } else {
        console.log('\x1b[36m║\x1b[0m  No configurations saved...' + ' '.repeat(w - 27) + '\x1b[36m║\x1b[0m');
    }
    
    console.log(mid);
    console.log('\x1b[36m║\x1b[0m  \x1b[33ma\x1b[0m - Add    \x1b[33ms\x1b[0m - Select    \x1b[33mm\x1b[0m - Model    \x1b[33md\x1b[0m - Del    \x1b[33mq\x1b[0m - Quit\x1b[36m║\x1b[0m');
    console.log(bot);
    
    const action = await question('\n\x1b[36mAction:\x1b[0m \x1b[90m> \x1b[0m');
    
    if (action === 'a') {
        console.log('\n\x1b[36mSelect provider type:\x1b[0m');
        console.log('  \x1b[33m1\x1b[0m. DeepSeek (cloud API)');
        console.log('  \x1b[33m2\x1b[0m. DeepInfra (cloud API)');
        console.log('  \x1b[33m3\x1b[0m. EasyAI Server (local/remote)');
        
        const provChoice = await question('\n\x1b[90m> \x1b[0m');
        
        let provider, token = null, model = null, serverUrl = null, serverPort = null, serverToken = null;
        
        if (provChoice === '1') {
            provider = 'deepseek';
            console.log('\n\x1b[36mPaste DeepSeek API token:\x1b[0m');
            console.log('\x1b[90m(Starts with sk-...)\x1b[0m');
            token = (await question('\x1b[90m> \x1b[0m')).trim();
            if (!token) return false;
            model = await selectModel('deepseek');
            
        } else if (provChoice === '2') {
            provider = 'deepinfra';
            console.log('\n\x1b[36mPaste DeepInfra API token:\x1b[0m');
            token = (await question('\x1b[90m> \x1b[0m')).trim();
            if (!token) return false;
            model = await selectModel('deepinfra');
            
        } else if (provChoice === '3') {
            provider = 'local';
            console.log('\n\x1b[36mEnter EasyAI server URL:\x1b[0m');
            console.log('\x1b[90mExamples: http://localhost, http://192.168.1.100\x1b[0m');
            serverUrl = (await question('\x1b[90m> \x1b[0m')).trim();
            if (!serverUrl) return false;
            
            console.log('\n\x1b[36mPort (Enter for default 4000):\x1b[0m');
            const portStr = (await question('\x1b[90m> \x1b[0m')).trim();
            serverPort = portStr ? parseInt(portStr) : 4000;
            
            console.log('\n\x1b[36mServer token (Enter to skip if no auth):\x1b[0m');
            serverToken = (await question('\x1b[90m> \x1b[0m')).trim() || null;
            
            model = await selectModel('local');
            
        } else {
            return false;
        }
        
        const name = await question('\n\x1b[36mConfiguration name (Enter for default):\x1b[0m \x1b[90m> \x1b[0m');
        const configName = name.trim() || 'default';
        
        configs[configName] = {
            provider,
            token,
            model,
            serverUrl,
            serverPort,
            serverToken
        };
        
        saved.configs = configs;
        if (!saved.activeConfig) {
            saved.activeConfig = configName;
        }
        
        writeFileSync(tokenPath, JSON.stringify(saved, null, 2));
        console.log('\n\x1b[32m✓ Configuration added!\x1b[0m');
        console.log(`\x1b[90m  Active: ${saved.activeConfig}\x1b[0m`);
        return true;
        
    } else if (action === 's' && configNames.length > 0) {
        console.log('\n\x1b[36mAvailable configurations:\x1b[0m');
        configNames.forEach(name => {
            const marker = name === activeConfig ? '\x1b[32m* \x1b[0m' : '  ';
            console.log(`${marker}${name}`);
        });
        
        const name = await question('\n\x1b[36mConfiguration name to activate:\x1b[0m \x1b[90m> \x1b[0m');
        if (configs[name.trim()]) {
            saved.activeConfig = name.trim();
            writeFileSync(tokenPath, JSON.stringify(saved, null, 2));
            console.log('\x1b[32m✓ Active configuration: ' + name.trim() + '\x1b[0m');
        } else {
            console.log('\x1b[31m✗ Configuration not found\x1b[0m');
        }
        return true;
        
    } else if (action === 'm' && configNames.length > 0) {
        const targetName = activeConfig || configNames[0];
        const cfg = configs[targetName];
        
        if (!cfg) return true;
        
        console.log(`\n\x1b[36mChanging model for: \x1b[33m${targetName}\x1b[0m`);
        console.log(`\x1b[90mCurrent model: ${cfg.model || 'none'}\x1b[0m`);
        
        const newModel = await selectModel(cfg.provider);
        cfg.model = newModel || null;
        
        saved.configs = configs;
        writeFileSync(tokenPath, JSON.stringify(saved, null, 2));
        console.log('\n\x1b[32m✓ Model updated!\x1b[0m');
        return true;
        
    } else if (action === 'd' && configNames.length > 0) {
        const name = await question('\n\x1b[36mConfiguration name to delete:\x1b[0m \x1b[90m> \x1b[0m');
        if (configs[name.trim()]) {
            delete configs[name.trim()];
            saved.configs = configs;
            if (saved.activeConfig === name.trim()) {
                saved.activeConfig = Object.keys(configs)[0] || null;
            }
            writeFileSync(tokenPath, JSON.stringify(saved, null, 2));
            console.log('\n\x1b[32m✓ Configuration deleted!\x1b[0m');
        } else {
            console.log('\x1b[31m✗ Configuration not found\x1b[0m');
        }
        return true;
        
    } else if (action === 'q') {
        return false;
    }
    
    return false;
}

async function parseArgs() {
    const args = process.argv.slice(2);
    const config = {};
    const tokenPath = path.join(process.cwd(), 'yandbox-config.json');
    let saved = existsSync(tokenPath) ? JSON.parse(readFileSync(tokenPath, 'utf8')) : {};
    
    // Migrate old format
    if (!saved.configs && saved.keys) {
        saved.configs = {};
        for (const name in saved.keys) {
            const entry = saved.keys[name];
            saved.configs[name] = {
                provider: entry.provider || (entry.token && entry.token.startsWith('sk-') ? 'deepseek' : 'deepinfra'),
                token: entry.token || null,
                model: entry.model || null,
                serverUrl: null,
                serverPort: null,
                serverToken: null
            };
        }
        delete saved.keys;
        saved.activeConfig = saved.activeConfig || Object.keys(saved.configs)[0] || null;
        writeFileSync(tokenPath, JSON.stringify(saved, null, 2));
    }
    
    // Handle 'new' command
    if (args.includes('new')) {
        console.log('\x1b[33m🆕 Starting fresh with new HTML pages...\x1b[0m\n');
        
        const htmlFiles = ['index.html', 'chat.html', 'main.html'];
        let removed = 0;
        
        for (const file of htmlFiles) {
            const filePath = path.join(process.cwd(), file);
            if (existsSync(filePath)) {
                try {
                    unlinkSync(filePath);
                    console.log(`\x1b[32m  ✓ Removed ${file}\x1b[0m`);
                    removed++;
                } catch (err) {
                    console.log(`\x1b[31m  ✗ Failed to remove ${file}: ${err.message}\x1b[0m`);
                }
            }
        }
        
        if (removed === 0) {
            console.log('\x1b[90m  No HTML files found to remove.\x1b[0m');
        } else {
            console.log(`\n\x1b[36m✓ Cleaned ${removed} HTML file(s). Configs preserved.\x1b[0m`);
        }
        console.log('\x1b[90mRun "node YandBox.js" to regenerate fresh pages.\x1b[0m\n');
        process.exit(0);
    }
    
    // Handle 'reset' command
    if (args.includes('reset')) {
        console.log('\x1b[33m🔄 Resetting YandBox...\x1b[0m\n');
        
        const filesToRemove = ['index.html', 'chat.html', 'main.html'];
        const jsonFiles = ['yandbox-config.json', 'yandbox-log.json', 'yandbox-versions.json'];
        let removed = 0;
        
        for (const file of [...filesToRemove, ...jsonFiles]) {
            const filePath = path.join(process.cwd(), file);
            if (existsSync(filePath)) {
                try {
                    unlinkSync(filePath);
                    console.log(`\x1b[32m  ✓ Removed ${file}\x1b[0m`);
                    removed++;
                } catch (err) {
                    console.log(`\x1b[31m  ✗ Failed to remove ${file}: ${err.message}\x1b[0m`);
                }
            }
        }
        
        if (removed === 0) {
            console.log('\x1b[90m  Nothing to reset. All files already clean.\x1b[0m');
        } else {
            console.log(`\n\x1b[36m✓ Reset complete! Removed ${removed} file(s).\x1b[0m`);
        }
        console.log('\x1b[90mRun "node YandBox.js" to start fresh.\x1b[0m\n');
        process.exit(0);
    }
    
    // Handle 'keys' or 'models' command
    if (args.includes('keys') || args.includes('models')) {
        await manageKeys();
        saved = existsSync(tokenPath) ? JSON.parse(readFileSync(tokenPath, 'utf8')) : {};
        if (saved.activeConfig && saved.configs?.[saved.activeConfig]) {
            return config;
        }
        process.exit(0);
    }
    
    // Handle --clear flag
    if (args.includes('--clear')) {
        writeFileSync(tokenPath, JSON.stringify({ 
            configs: saved.configs || {}, 
            activeConfig: saved.activeConfig || null,
            totalCost: saved.totalCost || 0
        }, null, 2));
        console.log('\x1b[32m✓ Logs cleared (configurations preserved)\x1b[0m');
        process.exit(0);
    }

    // Parse port argument
    for (const arg of args) {
        if (arg.startsWith('--port=')) {
            config.port = parseInt(arg.split('=')[1]);
        }
    }

    // Handle config name or token argument
    for (const arg of args) {
        if (!arg.startsWith('--')) {
            const configs = saved.configs || {};
            
            // Check if it's a saved configuration name
            if (configs[arg]) {
                saved.activeConfig = arg;
                writeFileSync(tokenPath, JSON.stringify(saved, null, 2));
                console.log(`\n\x1b[32m✓ Activated configuration: ${arg}\x1b[0m\n`);
                return config;
            }
            
            // Treat as API token (backward compatibility)
            const provider = arg.startsWith('sk-') ? 'deepseek' : 'deepinfra';
            const defaultModel = provider === 'deepseek' ? 'deepseek-v4-flash' : 'meta-llama/Meta-Llama-3.1-8B-Instruct';
            
            configs['default'] = {
                provider,
                token: arg,
                model: defaultModel,
                serverUrl: null,
                serverPort: null,
                serverToken: null
            };
            
            saved.configs = configs;
            saved.activeConfig = 'default';
            writeFileSync(tokenPath, JSON.stringify(saved, null, 2));
            
            console.log('\x1b[32m✓ ' + provider.toUpperCase() + ' token saved! Starting with default model.\x1b[0m');
            console.log('\x1b[90m  Run "node YandBox.js models" to change.\x1b[0m\n');
            return config;
        }
    }

    // No configuration found - interactive setup
    if (!saved.activeConfig || !saved.configs?.[saved.activeConfig]) {
        console.log('\x1b[33mNo API configuration found.\x1b[0m\n');
        console.log('\x1b[36mChoose provider type:\x1b[0m');
        console.log('  \x1b[33m1\x1b[0m. DeepSeek (cloud API)');
        console.log('  \x1b[33m2\x1b[0m. DeepInfra (cloud API)');
        console.log('  \x1b[33m3\x1b[0m. EasyAI Server (local/remote)');
        
        const choice = await question('\n\x1b[90m> \x1b[0m');
        
        let provider, token = null, model = null, serverUrl = null, serverPort = null, serverToken = null;
        
        if (choice === '1') {
            provider = 'deepseek';
            console.log('\n\x1b[36mPaste DeepSeek API token:\x1b[0m');
            token = (await question('\x1b[90m> \x1b[0m')).trim();
            if (!token) {
                console.log('\x1b[31mNo token provided. Exiting.\x1b[0m');
                process.exit(0);
            }
            model = 'deepseek-v4-flash';
            
        } else if (choice === '2') {
            provider = 'deepinfra';
            console.log('\n\x1b[36mPaste DeepInfra API token:\x1b[0m');
            token = (await question('\x1b[90m> \x1b[0m')).trim();
            if (!token) {
                console.log('\x1b[31mNo token provided. Exiting.\x1b[0m');
                process.exit(0);
            }
            model = 'meta-llama/Meta-Llama-3.1-8B-Instruct';
            
        } else if (choice === '3') {
            provider = 'local';
            console.log('\n\x1b[36mEnter EasyAI server URL:\x1b[0m');
            console.log('\x1b[90mExample: http://localhost\x1b[0m');
            serverUrl = (await question('\x1b[90m> \x1b[0m')).trim();
            if (!serverUrl) {
                console.log('\x1b[31mNo URL provided. Exiting.\x1b[0m');
                process.exit(0);
            }
            
            console.log('\n\x1b[36mPort (Enter for default 4000):\x1b[0m');
            const portStr = (await question('\x1b[90m> \x1b[0m')).trim();
            serverPort = portStr ? parseInt(portStr) : 4000;
            
            console.log('\n\x1b[36mServer token (Enter to skip):\x1b[0m');
            serverToken = (await question('\x1b[90m> \x1b[0m')).trim() || null;
            
            model = null;
            
        } else {
            console.log('\x1b[31mInvalid choice. Exiting.\x1b[0m');
            process.exit(0);
        }
        
        const configs = saved.configs || {};
        configs['default'] = {
            provider,
            token,
            model,
            serverUrl,
            serverPort,
            serverToken
        };
        
        saved.configs = configs;
        saved.activeConfig = 'default';
        writeFileSync(tokenPath, JSON.stringify(saved, null, 2));
        
        console.log('\n\x1b[32m✓ Configuration saved! Starting server...\x1b[0m\n');
        return config;
    }

    return config;
}

// Start the application
if (import.meta.url === `file://${process.argv[1]}`) {
    const config = await parseArgs();
    const yandbox = new YandBox(config);
}

export default YandBox;