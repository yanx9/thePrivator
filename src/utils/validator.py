"""Validators for different data types."""

import re
from urllib.parse import urlparse


def validate_user_agent(user_agent: str) -> bool:
    """Validates User-Agent string."""
    if not user_agent or not user_agent.strip():
        return False
        
    ua = user_agent.strip()
    
    # Check length
    if len(ua) < 10 or len(ua) > 1000:
        return False
        
    # Basic validation - check if contains typical UA elements
    ua_patterns = [
        r'Mozilla',
        r'Chrome',
        r'Safari',
        r'Firefox',
        r'Edge',
        r'Opera'
    ]
    
    # Must contain at least one popular identifier
    if not any(re.search(pattern, ua, re.IGNORECASE) for pattern in ua_patterns):
        return False
        
    # Check for dangerous characters
    dangerous_chars = ['<', '>', '"', "'", '&', '\n', '\r', '\t']
    if any(char in ua for char in dangerous_chars):
        return False
        
    return True


def validate_proxy(proxy: str) -> bool:
    """Validates proxy format."""
    if not proxy or not proxy.strip():
        return False
        
    proxy = proxy.strip()
    
    # Format: [protocol://]host:port
    if '://' in proxy:
        # With protocol
        try:
            parsed = urlparse(proxy)
            if not parsed.hostname or not parsed.port:
                return False
            if parsed.scheme not in ['http', 'https', 'socks4', 'socks5']:
                return False
        except:
            return False
    else:
        # Without protocol: host:port
        if ':' not in proxy:
            return False
            
        parts = proxy.split(':')
        if len(parts) != 2:
            return False
            
        host, port = parts
        
        # Host validation
        if not host or len(host) > 253:
            return False
            
        # Port validation
        try:
            port_num = int(port)
            if not (1 <= port_num <= 65535):
                return False
        except ValueError:
            return False
            
    return True


def validate_profile_name(name: str) -> bool:
    """Validates profile name."""
    if not name or not name.strip():
        return False
        
    name = name.strip()
    
    # Check length
    if len(name) < 1 or len(name) > 100:
        return False
        
    # Cannot contain filesystem special characters
    invalid_chars = r'[<>:"/\\|?*\x00-\x1f]'
    if re.search(invalid_chars, name):
        return False
        
    # Cannot end with dot or space (Windows)
    if name.endswith('.') or name.endswith(' '):
        return False
        
    # Cannot be Windows reserved names
    reserved_names = {
        'CON', 'PRN', 'AUX', 'NUL',
        'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
        'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
    }
    if name.upper() in reserved_names:
        return False
        
    return True


def validate_url(url: str) -> bool:
    """Validates URL."""
    if not url or not url.strip():
        return False
        
    try:
        parsed = urlparse(url.strip())
        return bool(parsed.scheme and parsed.netloc)
    except:
        return False


def validate_port(port: str) -> bool:
    """Validates port number."""
    try:
        port_num = int(port)
        return 1 <= port_num <= 65535
    except ValueError:
        return False


def sanitize_filename(filename: str) -> str:
    """Sanitizes filename by removing dangerous characters."""
    # Remove dangerous characters
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', filename)
    
    # Remove dots and spaces at the end
    filename = filename.rstrip('. ')
    
    # Limit length
    if len(filename) > 200:
        filename = filename[:200]
        
    return filename or "unnamed"