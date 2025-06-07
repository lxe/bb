# StockBot with Proxy Manager

A web scraping bot with separate proxy management for extracting data from Popmart product pages using AWS Fargate SOCKS5 proxies.

## Architecture

The system is now separated into two main components:

1. **Proxy Manager**: Stateful proxy management with persistent storage
2. **StockBot**: Web scraping bot that uses existing proxies

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure AWS credentials (ensure you have proper AWS access for ECS, EC2, IAM, and CloudWatch Logs)

## Proxy Management

### CLI Commands

Use the proxy CLI to manage your proxy pool:

```bash
# Create new proxies
node proxy-cli.js create 3

# List active proxies
node proxy-cli.js list

# Show proxy status
node proxy-cli.js status

# Show logs for all proxies
node proxy-cli.js logs

# Show logs for specific proxy
node proxy-cli.js logs <service-name>

# Teardown specific proxy
node proxy-cli.js teardown <service-name>

# Teardown all proxies
node proxy-cli.js teardown-all
```

### Using npm scripts

```bash
# Alternative way to run proxy CLI
npm run proxy create 3
npm run proxy list
npm run proxy status
```

### Proxy State Management

- Proxy state is automatically saved to `proxies.json`
- Proxies persist between CLI sessions
- State includes proxy URLs, regions, service names, and creation timestamps
- On startup, the system validates all stored proxies and removes inactive ones

## Running StockBot

Once you have active proxies, you can run the stockbot:

```bash
node stockbot.js <base_url> <count>
```

Example:
```bash
node stockbot.js https://www.popmart.com/us/pop-now/set/40-10006774100280 50
```

## Workflow

### First Time Setup
1. Create proxies: `node proxy-cli.js create 5`
2. Verify proxies: `node proxy-cli.js status`
3. Run stockbot: `node stockbot.js <url> <count>`

### Daily Usage
1. Check proxy status: `node proxy-cli.js status`
2. Run stockbot: `node stockbot.js <url> <count>`
3. Monitor logs if needed: `node proxy-cli.js logs`

### Maintenance
- View logs: `node proxy-cli.js logs`
- Clean up old proxies: `node proxy-cli.js teardown-all`
- Create fresh proxies: `node proxy-cli.js create <count>`

## Key Features

### Stateful Proxy Management
- ✅ Persistent proxy storage in `proxies.json`
- ✅ Automatic validation of stored proxies on startup
- ✅ Graceful handling of inactive/deleted proxies
- ✅ Separate lifecycle management from stockbot

### CLI Management
- ✅ Create proxies independently
- ✅ List and monitor active proxies
- ✅ Individual proxy teardown
- ✅ Bulk operations for all proxies
- ✅ Log viewing and monitoring

### StockBot Integration
- ✅ Uses existing proxy pool
- ✅ No proxy creation/destruction during scraping
- ✅ Efficient proxy rotation
- ✅ Graceful error handling when no proxies available

## File Structure

```
├── stockbot.js           # Main scraping bot
├── proxy-manager.js      # Stateful proxy manager
├── proxy-cli.js          # CLI for proxy management
├── proxies.json          # Proxy state storage (auto-generated)
├── package.json          # Dependencies and scripts
└── README.md             # This file
```

## Testing

### Test Existing Proxies

Test the functionality of your existing proxies without creating or destroying them:

```bash
# Basic test using existing proxies
npm run test:proxy

# Test with custom URL
node test-proxy-manager.js https://www.popmart.com/us/pop-now/set/40-10006774100280

# Test with logs displayed
node test-proxy-manager.js --logs

# Test and allow teardown (destroys proxies!)
node test-proxy-manager.js --teardown
npm run test:proxy:teardown
```

### Test System Separation

Test that the separated proxy system works correctly:

```bash
npm run test:separation
```

## Error Handling

- If no proxies are available, stockbot will exit with instructions to create proxies
- Invalid/inactive proxies are automatically removed from state
- AWS service errors are logged with helpful context
- CLI commands include proper error handling and user feedback

## AWS Resources

The proxy manager creates the following AWS resources:
- ECS Fargate tasks for SOCKS5 proxies running on port 1080 using [httptoolkit/docker-socks-tunnel](https://github.com/httptoolkit/docker-socks-tunnel)
- CloudWatch log groups for monitoring
- IAM roles for ECS execution
- Custom security group (`stockbot-socks5-proxy-sg`) with inbound rules for port 1080
- Network interfaces with public IPs

All resources are properly tagged and managed through the CLI.

### Security Configuration

The system automatically creates a security group named `stockbot-socks5-proxy-sg` that allows:
- **Inbound TCP traffic on port 1080** from anywhere (0.0.0.0/0) for SOCKS5 proxy access
- This replaces reliance on the default security group which typically blocks custom ports

If security group creation fails, the system falls back to the default security group (which may not allow proxy connections).

### Proxy Implementation

Uses the reliable [serjs/go-socks5-proxy](https://hub.docker.com/r/serjs/go-socks5-proxy) Docker image:
- Based on Go implementation of SOCKS5 proxy
- Lightweight and efficient
- No authentication required for simplicity  
- Runs on standard SOCKS5 port 1080 