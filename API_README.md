# thePrivator API

A comprehensive REST API for programmatic interaction with thePrivator - Chromium Profile Manager.

## 🚀 Getting Started

### Prerequisites

Install the required dependencies:

```bash
pip install -r requirements.txt
```

### Starting the API Server

Run thePrivator in API mode:

```bash
# Start API server on default port 8080
python -m theprivator --api-port 8080

# Or use a custom port
python -m theprivator --api-port 9000

# With custom configuration directory
python -m theprivator --api-port 8080 --config-dir /path/to/config
```

The API server will be available at `http://127.0.0.1:{port}`

## 📖 API Documentation

Once the server is running, you can access:

- **Interactive API Documentation (Swagger UI)**: `http://127.0.0.1:8080/docs`
- **ReDoc Documentation**: `http://127.0.0.1:8080/redoc`

## 🔧 API Endpoints

### System Endpoints

- `GET /health` - Health check
- `GET /system/info` - System information
- `GET /stats` - System statistics

### Profile Management

- `GET /profiles` - List all profiles
- `POST /profiles` - Create a new profile
- `GET /profiles/{id}` - Get profile by ID
- `PUT /profiles/{id}` - Update profile
- `DELETE /profiles/{id}` - Delete profile

### Profile Launching

- `POST /profiles/{id}/launch` - Launch profile
- `POST /profiles/{id}/terminate` - Terminate profile process
- `GET /profiles/{id}/process` - Get profile process info
- `GET /profiles/{id}/process/stats` - Get detailed process statistics

### Process Management

- `GET /processes` - List all running processes
- `POST /processes/terminate-all` - Terminate all processes
- `POST /processes/cleanup` - Clean up orphaned processes

### Import/Export

- `GET /profiles/{id}/export` - Export profile data
- `POST /profiles/import` - Import profile from data

### Configuration

- `GET /config` - Get configuration
- `PUT /config` - Update configuration

## 📝 Usage Examples

### Python Client Example

```python
import requests

# Base URL
api_url = "http://127.0.0.1:8080"

# Create a new profile
profile_data = {
    "name": "My Test Profile",
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "proxy": "http://proxy.example.com:8080",
    "notes": "Test profile created via API"
}

response = requests.post(f"{api_url}/profiles", json=profile_data)
profile = response.json()
print(f"Created profile: {profile['id']}")

# Launch the profile
launch_data = {
    "headless": True,
    "incognito": False,
    "additional_args": ["--disable-web-security"]
}

response = requests.post(f"{api_url}/profiles/{profile['id']}/launch", json=launch_data)
process = response.json()
print(f"Launched with PID: {process['pid']}")

# List all running processes
response = requests.get(f"{api_url}/processes")
processes = response.json()
print(f"Running processes: {len(processes)}")

# Terminate the profile
response = requests.post(f"{api_url}/profiles/{profile['id']}/terminate")
print("Profile terminated" if response.status_code == 204 else "Failed to terminate")
```

### cURL Examples

```bash
# Health check
curl -X GET http://127.0.0.1:8080/health

# List profiles
curl -X GET http://127.0.0.1:8080/profiles

# Create a profile
curl -X POST http://127.0.0.1:8080/profiles \
  -H "Content-Type: application/json" \
  -d '{
    "name": "API Test Profile",
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "notes": "Created via API"
  }'

# Launch a profile (replace {id} with actual profile ID)
curl -X POST http://127.0.0.1:8080/profiles/{id}/launch \
  -H "Content-Type: application/json" \
  -d '{"headless": true, "incognito": false}'

# Get system statistics
curl -X GET http://127.0.0.1:8080/stats
```

### JavaScript/Node.js Example

```javascript
const axios = require('axios');

const apiUrl = 'http://127.0.0.1:8080';

async function createAndLaunchProfile() {
  try {
    // Create profile
    const profileResponse = await axios.post(`${apiUrl}/profiles`, {
      name: 'JS Test Profile',
      user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      proxy: null,
      notes: 'Created from Node.js'
    });
    
    const profile = profileResponse.data;
    console.log(`Created profile: ${profile.id}`);
    
    // Launch profile
    const launchResponse = await axios.post(`${apiUrl}/profiles/${profile.id}/launch`, {
      headless: false,
      incognito: true,
      additional_args: []
    });
    
    const process = launchResponse.data;
    console.log(`Launched with PID: ${process.pid}`);
    
    // Wait 5 seconds then terminate
    setTimeout(async () => {
      await axios.post(`${apiUrl}/profiles/${profile.id}/terminate`);
      console.log('Profile terminated');
    }, 5000);
    
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

createAndLaunchProfile();
```

## 🧪 Testing the API

A test script is included to verify API functionality:

```bash
# Make sure the API server is running first
python -m theprivator --api-port 8080

# In another terminal, run the tests
python api_test.py
```

## 🛡️ Security Notes

- The API server binds to `127.0.0.1` (localhost only) by default for security
- No authentication is implemented - ensure the API is not exposed to untrusted networks
- Profile data directories are managed automatically and isolated per profile
- Chromium processes are launched with security flags and proper isolation

## 🔧 Configuration

The API respects thePrivator's configuration:

- **Custom Chromium Path**: Set via `/config` endpoint or GUI
- **Custom Data Directory**: Set via `--config-dir` argument or `/config` endpoint
- **Process Management**: Automatic cleanup of orphaned processes
- **Resource Limits**: Configurable maximum concurrent profiles

## 🐛 Error Handling

The API returns standard HTTP status codes:

- `200` - Success
- `201` - Created
- `204` - No Content (for deletions)
- `400` - Bad Request (validation errors)
- `404` - Not Found
- `422` - Validation Error
- `500` - Internal Server Error

Error responses include detailed information:

```json
{
  "error": "ValidationError",
  "detail": "Invalid proxy format",
  "timestamp": "2024-01-01T12:00:00"
}
```

## 🔌 Integration Examples

### CI/CD Pipeline Integration

```yaml
# Example GitHub Actions workflow
- name: Test with thePrivator
  run: |
    # Start API server in background
    python -m theprivator --api-port 8080 &
    API_PID=$!
    
    # Wait for server to start
    sleep 5
    
    # Run your tests that need browser profiles
    python run_browser_tests.py
    
    # Cleanup
    kill $API_PID
```

### Docker Integration

```dockerfile
FROM python:3.11

# Install thePrivator
COPY . /app
WORKDIR /app
RUN pip install -r requirements.txt

# Install Chromium
RUN apt-get update && apt-get install -y chromium-browser

# Expose API port
EXPOSE 8080

# Start API server
CMD ["python", "-m", "theprivator", "--api-port", "8080"]
```

## 📚 API Schema

The API uses OpenAPI 3.0 specification. Full schema is available at `/docs` when the server is running.

## 🤝 Contributing

Feel free to contribute improvements to the API:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## 📄 License

This API is part of thePrivator and follows the same license terms.