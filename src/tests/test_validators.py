"""Walidatory dla różnych typów danych."""

import re

def validate_user_agent(user_agent: str) -> bool:
    """Waliduje User-Agent string."""
    if not user_agent or not user_agent.strip():
        return False
        
    ua = user_agent.strip()
    
    # Sprawdź długość
    if len(ua) < 10 or len(ua) > 1000:
        return False
        
    # Podstawowa walidacja - sprawdza czy zawiera typowe elementy UA
    ua_patterns = [
        r'Mozilla',
        r'Chrome',
        r'Safari',
        r'Firefox',
        r'Edge',
        r'Opera'
    ]
    
    # Musi zawierać przynajmniej jeden z popularnych identyfikatorów
    if not any(re.search(pattern, ua, re.IGNORECASE) for pattern in ua_patterns):
        return False
        
    # Sprawdź czy nie zawiera niebezpiecznych znaków
    dangerous_chars = ['<', '>', '"', "'", '&', '\n', '\r', '\t']
    if any(char in ua for char in dangerous_chars):
        return False
        
    return True

def validate_proxy(proxy: str) -> bool:
    """Waliduje format proxy."""
    if not proxy or not proxy.strip():
        return False
        
    proxy = proxy.strip()
    
    # Format: [protocol://]host:port
    if '://' in proxy:
        # Z protokołem
        try:
            from urllib.parse import urlparse
            parsed = urlparse(proxy)
            if not parsed.hostname or not parsed.port:
                return False
            if parsed.scheme not in ['http', 'https', 'socks4', 'socks5']:
                return False
        except:
            return False
    else:
        # Bez protokołu: host:port
        if ':' not in proxy:
            return False
            
        parts = proxy.split(':')
        if len(parts) != 2:
            return False
            
        host, port = parts
        
        # Walidacja hosta
        if not host or len(host) > 253:
            return False
            
        # Walidacja portu
        try:
            port_num = int(port)
            if not (1 <= port_num <= 65535):
                return False
        except ValueError:
            return False
            
    return True

def validate_profile_name(name: str) -> bool:
    """Waliduje nazwę profilu."""
    if not name or not name.strip():
        return False
        
    name = name.strip()
    
    # Sprawdź długość
    if len(name) < 1 or len(name) > 100:
        return False
        
    # Nie może zawierać znaków specjalnych systemów plików
    invalid_chars = r'[<>:"/\\|?*\x00-\x1f]'
    if re.search(invalid_chars, name):
        return False
        
    # Nie może być kropką ani spacją na końcu (Windows)
    if name.endswith('.') or name.endswith(' '):
        return False
        
    return True