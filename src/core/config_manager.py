"""Application configuration manager."""

import json
from pathlib import Path
from typing import Dict, Any, Optional
from dataclasses import dataclass, asdict
from datetime import datetime
import sys

# Add src to path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from utils.logger import get_logger
from utils.exceptions import PrivatorException


@dataclass
class AppConfig:
    """Application configuration."""
    
    # GUI settings
    theme: str = "dark"
    color_theme: str = "blue"
    window_geometry: str = "900x700"
    
    # Chromium settings
    default_user_agent: str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    auto_cleanup: bool = True
    
    # Advanced settings
    max_concurrent_profiles: int = 10
    process_monitor_interval: int = 5
    
    def to_dict(self) -> Dict[str, Any]:
        """Converts to dictionary."""
        return asdict(self)
        
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'AppConfig':
        """Creates from dictionary."""
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


class ConfigManager:
    """Manages application configuration."""
    
    def __init__(self, config_dir: Optional[Path] = None):
        self.logger = get_logger(__name__)
        self.config_dir = config_dir or Path.home() / ".theprivator"
        self.config_dir.mkdir(exist_ok=True)
        self.config_file = self.config_dir / "config.json"
        
        self._config = AppConfig()
        self._load_config()
        
    def get(self, key: str, default: Any = None) -> Any:
        """Gets configuration value."""
        return getattr(self._config, key, default)
        
    def set(self, key: str, value: Any) -> None:
        """Sets configuration value."""
        if hasattr(self._config, key):
            setattr(self._config, key, value)
            self.save()
        else:
            self.logger.warning(f"Unknown configuration key: {key}")
            
    def save(self) -> None:
        """Saves configuration."""
        try:
            config_data = {
                'version': '2.0',
                'config': self._config.to_dict()
            }
            
            with open(self.config_file, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2, ensure_ascii=False)
                
        except Exception as e:
            self.logger.error(f"Error saving configuration: {e}")
            
    def _load_config(self) -> None:
        """Loads configuration from file."""
        try:
            if self.config_file.exists():
                with open(self.config_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    
                config_data = data.get('config', {})
                self._config = AppConfig.from_dict(config_data)
            else:
                self.save()
                
        except Exception as e:
            self.logger.error(f"Error loading configuration: {e}")
            self._config = AppConfig()
            
    def get_user_agents(self) -> Dict[str, str]:
        """Returns popular User-Agents."""
        return {
            "Chrome Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Chrome macOS": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Chrome Linux": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Firefox Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
            "Firefox macOS": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0",
            "Safari macOS": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.1 Safari/537.36",
            "Edge Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
        }