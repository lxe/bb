# StockBot with Advanced Proxy Management

A sophisticated web scraping system for monitoring Popmart product stock with AWS Fargate SOCKS5 proxies, live web dashboard, and intelligent priority queueing.

## 🌟 Key Features

### 🚀 **Multi-Product Monitoring**
- Monitor multiple products simultaneously with interleaved URL processing
- Fair priority distribution across all products
- Individual TSV data files per product

### ⚡ **Smart Priority Queue System**
- **3-tier priority levels**: HIGH (reserved + in-stock), MEDIUM (reserved), LOW (in-stock)
- **Line-cutting algorithm**: Higher priority URLs can jump ahead in queue
- **Time-based throttling**: 30-second minimum intervals between priority checks
- **Automatic detection**: Monitors for `state: 2` (reserved) and `state: 0` with `box_no` (in-stock)

### 🔄 **Persistent Page Workers**
- Dedicated browser pages with assigned proxies
- No page creation/destruction overhead
- Optimal concurrency: `min(urlCount, proxyCount)`
- 500ms delay between URL processing per worker

### 📊 **Live Web Dashboard**
- Real-time stock monitoring at `http://localhost:3000`
- Server-Sent Events (SSE) for instant updates
- **Visual indicators**:
  - Green glow/border for items with actual stock
  - Color-coded state dots: Green (available), Grey (reserved), Orange (other)
  - Different colors for out-of-stock items (lighter grey for empty slots)
- **Product sections** with seen/unseen URL counts
- **Copy in-stock URLs** functionality

### 🛡️ **Enterprise-Grade Proxy Security**
- Stateful proxy management with persistent storage
- WebRTC leak prevention with multiple browser flags
- HTTP header sanitization
- Direct IP connection blocking
- Fake Xfinity IP header injection

## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌────────────────┐
│   Proxy CLI     │    │    StockBot      │    │  Web Dashboard │
│                 │    │                  │    │                │
│ ┌─────────────┐ │    │ ┌──────────────┐ │    │ ┌────────────┐ │
│ │   Create    │ │    │ │ PriorityQueue│ │    │ │    SSE     │ │
│ │   List      │ │────┤ │ PageWorkers  │ ├────┤ │ Real-time  │ │
│ │   Monitor   │ │    │ │ DataPersist  │ │    │ │ Updates    │ │
│ │   Teardown  │ │    │ └──────────────┘ │    │ └────────────┘ │
│ └─────────────┘ │    └──────────────────┘    └────────────────┘
└─────────────────┘             │                        │
         │                      │                        │
         ▼                      ▼                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                     AWS Fargate SOCKS5 Proxies                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │   Proxy 1   │  │   Proxy 2   │  │   Proxy N   │            │
│  │ us-west-1   │  │ us-east-2   │  │ ca-central  │    ...     │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### 1. Installation
```bash
npm install
```

### 2. AWS Configuration
Ensure you have AWS credentials configured with permissions for:
- ECS (Fargate)
- EC2 (Security Groups, Network Interfaces)
- IAM (Role creation)
- CloudWatch Logs

### 3. Create Proxies
```bash
# Create 5 proxies across different regions
node proxy-cli.js create 5

# Verify proxies are active
node proxy-cli.js status
```

### 4. Monitor Products
```bash
# Single product
node stockbot.js https://www.popmart.com/us/pop-now/set/50-10009450600350 50

# Multiple products (recommended)
node stockbot.js \
  https://www.popmart.com/us/pop-now/set/50-10009450600350 50 \
  https://www.popmart.com/us/pop-now/set/195-10002025000585 30 \
  https://www.popmart.com/us/pop-now/set/270-10000294101890 25
```

### 5. View Live Dashboard
Open `http://localhost:3000` in your browser for real-time monitoring.

## 📋 Proxy Management Commands

```bash
# Proxy lifecycle
node proxy-cli.js create <count>     # Create new proxies
node proxy-cli.js list               # List all proxies
node proxy-cli.js status             # Show health status
node proxy-cli.js logs [service]     # View logs
node proxy-cli.js teardown <service> # Remove specific proxy
node proxy-cli.js teardown-all       # Remove all proxies

# Using npm scripts
npm run proxy create 3
npm run proxy status
npm run proxy logs
```

## ⚡ Priority Queue System

The system automatically prioritizes URLs based on stock conditions:

### Priority Levels
- **🔥 HIGH (Priority 1)**: Reserved + In-Stock (`state: 2` + `state: 0` with `box_no`)
- **🟡 MEDIUM (Priority 2)**: Reserved only (`state: 2`)
- **🟢 LOW (Priority 3)**: In-Stock only (`state: 0` with `box_no`)

### Line-Cutting Rules
- **HIGH priority**: Can cut up to 10 positions ahead
- **MEDIUM priority**: Can cut up to 5 positions ahead  
- **LOW priority**: Can cut up to 2 positions ahead

### Throttling
- Minimum 30-second intervals between priority checks
- Prevents overwhelming high-priority items
- Maintains fair rotation for regular URLs

## 📊 Web Dashboard Features

### Real-Time Monitoring
- **Live updates** via Server-Sent Events
- **Connection status** indicator
- **Loading states** with spinner animations
- **Automatic reconnection** on connection loss

### Visual Indicators
- **🟢 Green glow**: Items with actual stock available
- **State dots**: 
  - Green: Available slots
  - Grey: Reserved/unavailable slots  
  - Orange: Special states
  - Light grey: Empty slots (when out of stock)
- **Stock circles**: Green (in-stock), Red (out-of-stock), Grey (unknown)

### Product Organization
- **Separate sections** per product
- **Base URL links** for quick access
- **Seen/Unseen counters** for monitoring coverage
- **Copy in-stock URLs** for quick action

## 🔧 Configuration

### Worker Concurrency
Automatically optimized based on:
```javascript
workerCount = Math.min(urlCount, proxyCount)
```

### URL Pattern
Expected format: `https://www.popmart.com/us/pop-now/set/{spuId}-1000{5digits}{suffix}`
- Extracts `spuId` for product identification
- Increments the 5-digit number for URL generation

### Data Persistence
- Individual TSV files per product: `{spuId}.tsv`
- Columns: `url`, `state0-5`, `stock`, `lastChecked`
- Automatic data loading and updating

## 🛡️ Security Features

### Proxy Security
- **WebRTC blocking**: Multiple browser flags prevent IP leaks
- **Header sanitization**: Removes IP-revealing headers
- **Direct IP prevention**: Blocks direct IP connections
- **Fake headers**: Injects Xfinity IP headers

### AWS Security
- **Custom security group**: `stockbot-socks5-proxy-sg`
- **Minimal permissions**: Only port 1080 access
- **Proper tagging**: All resources tagged for management
- **Auto-cleanup**: Failed resources automatically removed

## 📁 File Structure

```
stockbot/
├── stockbot.js              # Main application with PriorityQueue
├── proxy-manager.js         # Stateful AWS proxy management  
├── proxy-cli.js             # CLI for proxy operations
├── web-server.js            # Live dashboard server
├── public/
│   └── index.html           # Web dashboard interface
├── proxies.json             # Proxy state (auto-generated)
├── {spuId}.tsv              # Product data files (auto-generated)
├── PROXY_SECURITY.md        # Security documentation
├── package.json             # Dependencies
└── README.md                # This file
```

## 🧪 Testing & Debugging

### Proxy Testing
```bash
# Test existing proxies
node test-ip-leak.js

# Test connectivity
npm run test:connectivity
```

### Debug Features
- **Screenshot capture** for failed requests
- **Detailed logging** with emoji indicators
- **Debug endpoints**: `/api/stock`, `/health`
- **Console logging**: Priority queue status, worker activity

## 🔍 Monitoring

### Console Output
```
📊 Workers: 6/6 active | Round-robin: cycle 1, position 3/30 | Priority: HIGH: 2, MEDIUM: 1
🔥 Set priority HIGH: https://example.com/set/50-123 (reserved + in-stock)
⚡ Priority check (HIGH): https://example.com/set/50-123
💾 [us-west-1] Updated: https://example.com/set/50-123 [0 1 1 1 1 1] stock:true
```

### Web Dashboard Metrics
- Total URLs monitored
- Active products
- Real-time connection status
- Last update timestamps

## 🚨 Error Handling

### Graceful Failures
- **No proxies**: Clear instructions to create proxies
- **Invalid URLs**: Pattern validation with examples
- **AWS errors**: Detailed error messages with context
- **Connection issues**: Automatic retry with exponential backoff

### Recovery Mechanisms
- **Proxy validation**: Removes inactive proxies automatically
- **Worker restart**: Failed workers auto-restart with new proxies
- **Data consistency**: TSV files protected against corruption

## 🏷️ AWS Resources

The system creates and manages:
- **ECS Fargate tasks**: SOCKS5 proxy containers
- **CloudWatch log groups**: Monitoring and debugging
- **IAM roles**: Minimal required permissions
- **Security groups**: Port 1080 access only
- **Network interfaces**: Public IPs for proxy access

All resources are properly tagged with `Project: stockbot` for easy management.

## 💡 Best Practices

### Performance
- Use 10-20 proxies for optimal performance
- Monitor 50-100 URLs per product maximum
- Run on stable network connection

### Security  
- Regularly rotate proxies (weekly)
- Monitor for IP leaks using test tools
- Use high-quality proxy providers

### Monitoring
- Keep web dashboard open for real-time monitoring
- Set up alerts for in-stock items
- Regular backup of TSV data files

## 🔧 Troubleshooting

### Common Issues
1. **No proxies available**: Run `node proxy-cli.js create 5`
2. **URLs not loading**: Check proxy status with `node proxy-cli.js status`
3. **Dashboard not updating**: Verify port 3000 is accessible
4. **AWS errors**: Check credentials and permissions

### Support Commands
```bash
# Check proxy health
node proxy-cli.js status

# View detailed logs  
node proxy-cli.js logs

# Test connectivity
node test-ip-leak.js

# Debug web dashboard
curl http://localhost:3000/api/stock
```

---

**Built with ❤️ for efficient Popmart stock monitoring** 