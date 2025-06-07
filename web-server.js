const express = require('express');
const fs = require('fs').promises;
const path = require('path');

class WebServer {
  constructor(stockBot) {
    this.app = express();
    this.stockBot = stockBot;
    this.clients = new Set();
    this.port = 3000;
    this.server = null;
  }

  setupRoutes() {
    // Serve static files from public directory
    this.app.use(express.static(path.join(__dirname, 'public')));

    // Main dashboard route - serve static HTML
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // SSE endpoint for real-time updates
    this.app.get('/events', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });

      // Send initial data
      this.sendInitialData(res);

      // Add client to our set
      this.clients.add(res);

      // Handle client disconnect
      req.on('close', () => {
        this.clients.delete(res);
        console.log(`📡 Client disconnected. ${this.clients.size} clients remaining.`);
      });

      console.log(`📡 New SSE client connected. ${this.clients.size} clients total.`);
    });

    // API endpoint to get current stock data (for debugging/external access)
    this.app.get('/api/stock', async (req, res) => {
      try {
        const stockData = await this.getCurrentStockData();
        res.json({
          success: true,
          data: stockData,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        clients: this.clients.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });
  }

  async sendInitialData(res) {
    try {
      const stockData = await this.getCurrentStockData();
      const message = {
        type: 'initial',
        data: stockData,
        timestamp: new Date().toISOString()
      };
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    } catch (error) {
      console.error('Error sending initial data:', error);
      const errorMessage = {
        type: 'error',
        message: 'Failed to load initial data',
        timestamp: new Date().toISOString()
      };
      res.write(`data: ${JSON.stringify(errorMessage)}\n\n`);
    }
  }

  async getCurrentStockData() {
    const result = {};
    
    // Process each product
    for (const product of this.stockBot.products) {
      const spuExtId = product.spuExtId;
      const urlMap = this.stockBot.stockData.get(spuExtId) || new Map();
      
      console.log(`🔍 Product ${spuExtId}: urlMap has ${urlMap.size} entries, product.urls has ${product.urls.length} entries`);
      
      let seenCount = 0;
      let unseenCount = 0;
      
      result[spuExtId] = {
        baseUrl: product.baseUrl,
        totalUrls: product.count,
        urls: product.urls.map(url => {
          const entry = urlMap.get(url);
          if (entry) {
            // URL has been processed before
            seenCount++;
            return {
              url: entry.url,
              states: [entry.state0, entry.state1, entry.state2, entry.state3, entry.state4, entry.state5],
              stock: entry.stock === 'true',
              lastChecked: entry.lastChecked,
              status: 'seen'
            };
          } else {
            // URL has never been processed
            unseenCount++;
            return {
              url,
              states: ['', '', '', '', '', ''],
              stock: false,
              lastChecked: null,
              status: 'unseen'
            };
          }
        })
      };
      
      console.log(`🔍 Product ${spuExtId}: ${seenCount} seen, ${unseenCount} unseen`);
      
      // Debug: Show first few URLs from both sets
      if (urlMap.size > 0) {
        console.log(`🔍 First 3 URLs in urlMap:`, Array.from(urlMap.keys()).slice(0, 3));
      }
      console.log(`🔍 First 3 URLs in product.urls:`, product.urls.slice(0, 3));
    }
    
    return result;
  }

  broadcastUpdate(spuExtId, url, entry) {
    if (this.clients.size === 0) {
      return; // No clients to broadcast to
    }

    const updateData = {
      type: 'update',
      spuExtId,
      url,
      data: {
        url: entry.url,
        states: [entry.state0, entry.state1, entry.state2, entry.state3, entry.state4, entry.state5],
        stock: entry.stock === 'true',
        lastChecked: entry.lastChecked
      },
      timestamp: new Date().toISOString()
    };

    const message = `data: ${JSON.stringify(updateData)}\n\n`;
    
    // Send to all connected clients
    const clientsToRemove = [];
    for (const client of this.clients) {
      try {
        client.write(message);
      } catch (error) {
        console.warn('Error sending to client:', error.message);
        clientsToRemove.push(client);
      }
    }
    
    // Remove disconnected clients
    clientsToRemove.forEach(client => this.clients.delete(client));
  }

  broadcastLoading(url, region) {
    if (this.clients.size === 0) {
      return; // No clients to broadcast to
    }

    // Find which product this URL belongs to
    let spuExtId = null;
    for (const product of this.stockBot.products) {
      if (product.urls.includes(url)) {
        spuExtId = product.spuExtId;
        break;
      }
    }

    const loadingData = {
      type: 'loading',
      url,
      region,
      spuExtId,
      timestamp: new Date().toISOString()
    };

    const message = `data: ${JSON.stringify(loadingData)}\n\n`;
    
    // Send to all connected clients
    const clientsToRemove = [];
    for (const client of this.clients) {
      try {
        client.write(message);
      } catch (error) {
        console.warn('Error sending loading state to client:', error.message);
        clientsToRemove.push(client);
      }
    }
    
    // Remove disconnected clients
    clientsToRemove.forEach(client => this.clients.delete(client));
  }

  broadcastLoadingComplete(url) {
    if (this.clients.size === 0) {
      return; // No clients to broadcast to
    }

    const loadingCompleteData = {
      type: 'loading_complete',
      url,
      timestamp: new Date().toISOString()
    };

    const message = `data: ${JSON.stringify(loadingCompleteData)}\n\n`;
    
    // Send to all connected clients
    const clientsToRemove = [];
    for (const client of this.clients) {
      try {
        client.write(message);
      } catch (error) {
        console.warn('Error sending loading complete to client:', error.message);
        clientsToRemove.push(client);
      }
    }
    
    // Remove disconnected clients
    clientsToRemove.forEach(client => this.clients.delete(client));
  }

  start() {
    this.setupRoutes();
    
    this.server = this.app.listen(this.port, () => {
      console.log(`🌐 Web dashboard available at: http://localhost:${this.port}`);
      console.log(`📁 Serving static files from: ${path.join(__dirname, 'public')}`);
    });
  }

  stop() {
    if (this.server) {
      // Close all SSE connections
      for (const client of this.clients) {
        try {
          client.end();
        } catch (error) {
          // Ignore errors when closing
        }
      }
      this.clients.clear();
      
      this.server.close();
      console.log('🛑 Web server stopped');
    }
  }
}

module.exports = WebServer; 