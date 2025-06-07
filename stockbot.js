const puppeteer = require('puppeteer');
const useProxy = require('@lem0-packages/puppeteer-page-proxy');
const { ProxyManager } = require('./proxy-manager');
const WebServer = require('./web-server');
const fs = require('fs').promises;

class AsyncQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  async add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        task,
        resolve,
        reject
      });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    this.running++;
    const { task, resolve, reject } = this.queue.shift();

    try {
      const result = await task();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      this.process();
    }
  }
}

class StockBot {
  constructor() {
    this.browser = null;
    this.proxyManager = new ProxyManager();
    this.proxies = [];
    this.stockData = new Map(); // Internal JSON structure: spuExtId -> Map(url -> stockEntry)
    this.urls = [];
    this.currentUrlIndex = 0;
    this.isRunning = false;
    this.webServer = null;
    this.proxyStatus = new Map(); // proxy.url -> { busy: boolean, currentUrl: string|null }
  }

  async init() {
    console.log('🚀 Initializing StockBot...');
    await this.setupProxies();
    await this.launchBrowser();
    
    // Initialize proxy status tracking
    this.proxies.forEach(proxy => {
      this.proxyStatus.set(proxy.url, { busy: false, currentUrl: null });
    });
    
    console.log(`🔧 Proxy status tracking initialized for ${this.proxies.length} proxies`);
    
         // Monitor proxy utilization every 3 seconds
     this.proxyMonitor = setInterval(() => {
       if (this.isRunning) {
         const busyProxies = Array.from(this.proxyStatus.values()).filter(status => status.busy).length;
         const freeProxies = this.proxies.length - busyProxies;
         const currentCycle = Math.floor(this.currentUrlIndex / this.urls.length) + 1;
         const positionInCycle = (this.currentUrlIndex % this.urls.length) + 1;
         console.log(`📊 Proxies: ${busyProxies}/${this.proxies.length} busy, ${freeProxies} free | Round-robin: cycle ${currentCycle}, position ${positionInCycle}/${this.urls.length}`);
       }
     }, 3000);
    
    // Initialize web server
    this.webServer = new WebServer(this);
    this.webServer.start();
  }

  async setupProxies() {
    await this.proxyManager.init();
    this.proxies = this.proxyManager.getActiveProxies();
    
    if (this.proxies.length === 0) {
      console.log('⚠️  No active proxies found. Please create proxies using: node proxy-cli.js create <count>');
      throw new Error('No proxies available. Use proxy-cli to create proxies first.');
    }
    
    console.log(`✅ ${this.proxies.length} proxies loaded for maximum parallelism`);
  }

  async launchBrowser() {
    console.log('🌐 Launching single browser instance...');
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--ignore-ssl-errors'
      ]
    });
    console.log('✅ Browser launched');
  }

  async loadExistingTsvData(spuExtId) {
    const filename = `${spuExtId}.tsv`;
    console.log(`📂 Loading existing data from ${filename}...`);
    
    try {
      const content = await fs.readFile(filename, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      
      if (lines.length <= 1) {
        console.log(`📄 ${filename} is empty or only has headers`);
        return;
      }

      const headers = lines[0].split('\t');
      const urlMap = new Map();
      
      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split('\t');
        const entry = {};
        headers.forEach((header, index) => {
          entry[header] = values[index] || '';
        });
        
        if (entry.url) {
          urlMap.set(entry.url, entry);
        }
      }
      
      this.stockData.set(spuExtId, urlMap);
      console.log(`✅ Loaded ${urlMap.size} existing entries for ${filename}`);
      
    } catch (error) {
      console.log(`📄 ${filename} doesn't exist yet, will create new one`);
      this.stockData.set(spuExtId, new Map());
    }
  }

  async updateTsvFile(spuExtId) {
    const filename = `${spuExtId}.tsv`;
    const urlMap = this.stockData.get(spuExtId);
    
    if (!urlMap || urlMap.size === 0) {
      return;
    }

    const headers = ['url', 'state0', 'state1', 'state2', 'state3', 'state4', 'state5', 'stock', 'lastChecked'];
    const headerLine = headers.join('\t');
    
    const dataLines = Array.from(urlMap.values()).map(entry => 
      headers.map(header => entry[header] || '').join('\t')
    );
    
    const tsvContent = [headerLine, ...dataLines].join('\n');
    
    await fs.writeFile(filename, tsvContent);
  }

  generateUrls(baseUrl, count) {
    console.log(`📋 Generating ${count} URLs from base: ${baseUrl}`);
    
    // Correct pattern matching for PopMart URLs
    // Examples: 
    // - https://www.popmart.com/us/pop-now/set/195-10002154800585
    // - https://www.popmart.com/us/pop-now/set/40-10006774100280
    // Pattern: {prefix}-1000{5digits}{suffix} where the 5 digits get incremented
    const urlPattern = /^(.+-1000)(\d{5})(\d+)$/;
    const match = baseUrl.match(urlPattern);
    
    if (!match) {
      throw new Error('❌ Invalid URL pattern. Expected format: .../[PREFIX]-1000[5DIGITS][SUFFIX] where the 5 digits will be incremented');
    }

    const prefix = match[1]; // Everything up to and including "-1000"
    const baseNumber = parseInt(match[2]); // The 5-digit sequence to increment
    const suffix = match[3]; // The suffix after the 5 digits
    
    const urls = [];
    
    for (let i = 0; i < count; i++) {
      const newNumber = baseNumber + i;
      // Pad to 5 digits with leading zeros
      const paddedNumber = newNumber.toString().padStart(5, '0');
      const newUrl = `${prefix}${paddedNumber}${suffix}`;
      urls.push(newUrl);
    }

    console.log(`✅ Generated ${urls.length} URLs (${baseNumber.toString().padStart(5, '0')} to ${(baseNumber + count - 1).toString().padStart(5, '0')})`);
    return urls;
  }

  getNextUrl() {
    if (this.urls.length === 0) return null;
    
    const url = this.urls[this.currentUrlIndex];
    this.currentUrlIndex = (this.currentUrlIndex + 1) % this.urls.length; // Round-robin!
    return url;
  }

  getFreeProxy() {
    for (const proxy of this.proxies) {
      const status = this.proxyStatus.get(proxy.url);
      if (!status.busy) {
        return proxy;
      }
    }
    return null;
  }

  setProxyBusy(proxy, url) {
    const status = this.proxyStatus.get(proxy.url);
    status.busy = true;
    status.currentUrl = url;
    console.log(`🔄 [${proxy.region}] Starting: ${url}`);
    
    // Send loading state immediately when proxy allocated
    if (this.webServer) {
      this.webServer.broadcastLoading(url, proxy.region);
      console.log(`📡 [${proxy.region}] Sent loading event for: ${url}`);
    }
  }

  setProxyFree(proxy) {
    const status = this.proxyStatus.get(proxy.url);
    const url = status.currentUrl;
    status.busy = false;
    status.currentUrl = null;
    console.log(`✅ [${proxy.region}] Completed: ${url}`);
    
    // FIXED: Saturate ALL available proxies, not just one
    this.saturateAvailableProxies();
  }

  async processUrl(url, proxy) {
    const startTime = Date.now();
    
    // Mark proxy as busy (loading state sent in setProxyBusy)
    this.setProxyBusy(proxy, url);
    
    const page = await this.browser.newPage();
    
    try {
      const pageCreateTime = Date.now();
      
      // Set proxy for this specific page
      await useProxy(page, proxy.url);
      const proxySetTime = Date.now();
      
      const extractedData = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve(null);
        }, 30000);

        page.on('response', async (response) => {
          const responseUrl = response.url();
          
          if (responseUrl.includes('prod-na-api.popmart.com/shop/v1/box/box_set/refreshBox')) {
            try {
              const jsonData = await response.json();
              clearTimeout(timeout);
              resolve(jsonData);
            } catch (error) {
              console.warn(`⚠️  Failed to parse JSON from ${responseUrl}:`, error.message);
              clearTimeout(timeout);
              resolve(null);
            }
          }
        });

        page.goto(url, { waitUntil: 'networkidle2' }).catch(reject);
      });
      
      const dataExtractionTime = Date.now();

      if (extractedData && extractedData.data && extractedData.data.box_list) {
        const spuExtId = extractedData.data.spu_ext_id;
        const boxList = extractedData.data.box_list;
        
        // Extract states from box_list (positions 1-6, but we want indices 0-5)
        const states = new Array(6).fill('');
        let hasStock = false;
        
        boxList.forEach(box => {
          if (box.position >= 1 && box.position <= 6) {
            states[box.position - 1] = box.state.toString();
            
            // Check if any box has a non-empty box_no (indicates stock availability)
            if (box.box_no && box.box_no.trim() !== '') {
              hasStock = true;
            }
          }
        });

        const stockEntry = {
          url: url,
          state0: states[0] || '',
          state1: states[1] || '',
          state2: states[2] || '',
          state3: states[3] || '',
          state4: states[4] || '',
          state5: states[5] || '',
          stock: hasStock ? 'true' : 'false',
          lastChecked: new Date().toISOString()
        };

        // Check if data changed
        if (!this.stockData.has(spuExtId)) {
          await this.loadExistingTsvData(spuExtId);
        }

        const urlMap = this.stockData.get(spuExtId);
        const existingEntry = urlMap.get(url);
        const statesString = states.join(' ');

        let dataChanged = false;
        if (!existingEntry) {
          dataChanged = true;
          console.log(`🆕 [${proxy.region}] New entry: ${url} [${statesString}] stock:${hasStock}`);
        } else {
          const oldStates = [existingEntry.state0, existingEntry.state1, existingEntry.state2, 
                           existingEntry.state3, existingEntry.state4, existingEntry.state5].join(' ');
          const oldStock = existingEntry.stock === 'true';
          
          if (oldStates !== statesString || oldStock !== hasStock) {
            dataChanged = true;
            const stockChange = oldStock !== hasStock ? ` stock:${oldStock}→${hasStock}` : '';
            console.log(`🔄 [${proxy.region}] State changed: ${url} [${oldStates}] → [${statesString}]${stockChange}`);
          } else {
            console.log(`✅ [${proxy.region}] No change: ${url} [${statesString}] stock:${hasStock}`);
          }
        }

        // Update internal structure
        urlMap.set(url, stockEntry);

        // Update TSV file immediately if data changed
        if (dataChanged) {
          await this.updateTsvFile(spuExtId);
          console.log(`💾 [${proxy.region}] Updated ${spuExtId}.tsv`);
        }

        const dataProcessingTime = Date.now();

        // Broadcast update to web clients
        if (this.webServer) {
          this.webServer.broadcastUpdate(spuExtId, url, stockEntry);
        }

        const totalTime = Date.now();

        // Log detailed timing information
        const timings = {
          pageCreate: pageCreateTime - startTime,
          proxySet: proxySetTime - pageCreateTime,
          dataExtraction: dataExtractionTime - proxySetTime,
          dataProcessing: dataProcessingTime - dataExtractionTime,
          webBroadcast: totalTime - dataProcessingTime,
          total: totalTime - startTime
        };

        console.log(`⏱️  [${proxy.region}] ${url} - Total: ${timings.total}ms | Page: ${timings.pageCreate}ms | Proxy: ${timings.proxySet}ms | Extract: ${timings.dataExtraction}ms | Process: ${timings.dataProcessing}ms | Broadcast: ${timings.webBroadcast}ms`);
      } else {
        const totalTime = Date.now();
        const timings = {
          pageCreate: pageCreateTime - startTime,
          proxySet: proxySetTime - pageCreateTime,
          dataExtraction: dataExtractionTime - proxySetTime,
          total: totalTime - startTime
        };

        console.log(`📭 [${proxy.region}] No API data found for ${url} - Total: ${timings.total}ms | Page: ${timings.pageCreate}ms | Proxy: ${timings.proxySet}ms | Extract: ${timings.dataExtraction}ms`);

        // Take screenshot for debugging
        try {
          const urlId = this.extractIdFromUrl(url);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const screenshotPath = `debug-${urlId}-${timestamp}.png`;
          
          await page.screenshot({ 
            path: screenshotPath, 
            fullPage: true,
            type: 'png'
          });
          
          console.log(`📸 [${proxy.region}] Screenshot saved: ${screenshotPath}`);
        } catch (screenshotError) {
          console.error(`❌ [${proxy.region}] Failed to save screenshot: ${screenshotError.message}`);
        }
      }
      
    } catch (error) {
      const errorTime = Date.now();
      const timings = {
        total: errorTime - startTime
      };
      console.error(`❌ [${proxy.region}] Error processing ${url} after ${timings.total}ms:`, error.message);
      
      // Clear loading state on error
      if (this.webServer) {
        this.webServer.broadcastLoadingComplete(url);
      }
    } finally {
      await page.close();
      // Free the proxy for next use
      this.setProxyFree(proxy);
    }
  }

  // NEW METHOD: Ensure all free proxies get work
  saturateAvailableProxies() {
    if (!this.isRunning) return;
    
    let startedCount = 0;
    
    // Keep starting URLs until no more free proxies or no more URLs
    while (true) {
      const freeProxy = this.getFreeProxy();
      if (!freeProxy) {
        // No free proxies available
        break;
      }
      
      const nextUrl = this.getNextUrl();
      if (!nextUrl) {
        console.log('⚠️ No URLs available to process');
        break;
      }
      
      // Start processing immediately
      this.processUrl(nextUrl, freeProxy).catch(error => {
        console.error(`❌ Failed to process ${nextUrl}:`, error.message);
        // Make sure to free the proxy on error and try to saturate again
        this.setProxyFree(freeProxy);
      });
      
      startedCount++;
    }
    
    if (startedCount > 0) {
      console.log(`🚀 Started ${startedCount} new URL(s) on freed proxies`);
    }
  }

  async startContinuousMonitoring() {
    console.log('🔄 Starting continuous monitoring...');
    this.isRunning = true;
    
    // Initial saturation: fill all proxies with work
    console.log('🚀 Initial proxy saturation...');
    this.saturateAvailableProxies();

    // Keep running until manually stopped
    while (this.isRunning) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // OPTIONAL: Periodic saturation check (safety net)
      // This ensures saturation even if some edge case causes proxies to not get work
      this.saturateAvailableProxies();
    }
  }

  extractIdFromUrl(url) {
    // Extract meaningful ID from URL for filenames
    // Example: https://www.popmart.com/us/pop-now/set/195-10002154800585 -> 195-10002154800585
    const match = url.match(/(\d+-\d+)$/);
    return match ? match[1] : 'unknown';
  }

  async stop() {
    console.log('\n🛑 Stopping continuous monitoring...');
    this.isRunning = false;
    
    if (this.proxyMonitor) {
      clearInterval(this.proxyMonitor);
    }
    
    if (this.webServer) {
      this.webServer.stop();
    }
  }

  async cleanup() {
    console.log('🧹 Cleaning up...');
    
    if (this.browser) {
      await this.browser.close();
    }
    
    if (this.webServer) {
      this.webServer.stop();
    }
    
    console.log('✅ Cleanup complete');
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.error('❌ Usage: node stockbot.js <base_url> <count>');
    console.error('Example: node stockbot.js https://www.popmart.com/us/pop-now/set/195-10002154800585 50');
    process.exit(1);
  }

  const [baseUrl, countStr] = args;
  const count = parseInt(countStr);
  
  if (isNaN(count) || count <= 0) {
    console.error('❌ Count must be a positive number');
    process.exit(1);
  }

  const stockBot = new StockBot();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await stockBot.stop();
    await stockBot.cleanup();
    process.exit(0);
  });
  
  try {
    await stockBot.init();
    
    stockBot.urls = stockBot.generateUrls(baseUrl, count);
    
    // Load existing data for all unique prefixes
    const prefixes = new Set();
    stockBot.urls.forEach(url => {
      const match = url.match(/(\d+)-1000\d+/);
      if (match) {
        prefixes.add(parseInt(match[1]));
      }
    });
    
    for (const prefix of prefixes) {
      await stockBot.loadExistingTsvData(prefix);
    }
    
    await stockBot.startContinuousMonitoring();
    
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  } finally {
    await stockBot.cleanup();
  }
}

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  process.exit(1);
});

if (require.main === module) {
  main();
}

module.exports = StockBot;
