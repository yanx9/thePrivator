"""Legacy profile migration system for thePrivator."""

import json
import shutil
from pathlib import Path
from typing import List, Dict, Optional, Any, Tuple
import sys
from datetime import datetime

# Add src to path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from core.profile_manager import ProfileManager, ChromiumProfile
from utils.logger import get_logger
from utils.exceptions import ProfileError, ValidationError
from utils.validator import validate_profile_name, validate_user_agent


class LegacyProfileMigrator:
    """Handles migration from old profile format to new format."""
    
    def __init__(self, profile_manager: ProfileManager):
        self.profile_manager = profile_manager
        self.logger = get_logger(__name__)
        
    def scan_legacy_profiles(self, legacy_dir: Path) -> List[Dict[str, Any]]:
        """Scans for legacy profiles in the old Profiles/ directory."""
        legacy_profiles = []
        
        if not legacy_dir.exists() or not legacy_dir.is_dir():
            self.logger.info(f"Legacy directory not found: {legacy_dir}")
            return legacy_profiles
            
        try:
            for profile_folder in legacy_dir.iterdir():
                if not profile_folder.is_dir():
                    continue
                    
                config_file = profile_folder / "config.json"
                user_data_dir = profile_folder / "user-data"
                
                if not config_file.exists():
                    self.logger.warning(f"No config.json found in {profile_folder.name}")
                    continue
                    
                try:
                    with open(config_file, 'r', encoding='utf-8') as f:
                        config = json.load(f)
                        
                    legacy_profile = {
                        'folder_path': profile_folder,
                        'config': config,
                        'has_user_data': user_data_dir.exists(),
                        'user_data_size': self._calculate_folder_size(user_data_dir) if user_data_dir.exists() else 0
                    }
                    
                    legacy_profiles.append(legacy_profile)
                    
                except Exception as e:
                    self.logger.warning(f"Error reading config from {profile_folder.name}: {e}")
                    continue
                    
        except Exception as e:
            self.logger.error(f"Error scanning legacy profiles: {e}")
            
        self.logger.info(f"Found {len(legacy_profiles)} legacy profiles")
        return legacy_profiles
        
    def convert_legacy_profile(self, legacy_data: Dict[str, Any]) -> Tuple[ChromiumProfile, bool]:
        """Converts a legacy profile to new format."""
        config = legacy_data['config']
        folder_path = legacy_data['folder_path']
        
        # Extract basic information
        name = config.get('name', folder_path.name)
        user_agent = config.get('user_agent', '')
        
        # Validate and sanitize name
        if not validate_profile_name(name):
            # Generate safe name from folder name
            name = self._sanitize_profile_name(folder_path.name)
            
        # Ensure unique name
        original_name = name
        counter = 1
        while self.profile_manager.get_profile_by_name(name):
            name = f"{original_name} ({counter})"
            counter += 1
            
        # Validate user agent
        if not validate_user_agent(user_agent):
            user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            self.logger.warning(f"Invalid user agent in {name}, using default")
            
        # Convert proxy settings
        proxy = self._convert_proxy_settings(config)
        
        # Create notes with additional information
        notes = self._create_migration_notes(config)
        
        try:
            # Create new profile
            new_profile = self.profile_manager.create_profile(
                name=name,
                user_agent=user_agent,
                proxy=proxy,
                notes=notes
            )
            
            # Copy user data if it exists
            user_data_copied = False
            if legacy_data['has_user_data']:
                user_data_copied = self._copy_user_data(
                    folder_path / "user-data",
                    Path(new_profile.user_data_dir)
                )
                
            return new_profile, user_data_copied
            
        except (ValidationError, ProfileError) as e:
            self.logger.error(f"Error converting legacy profile {name}: {e}")
            raise
            
    def migrate_selected_profiles(self, legacy_dir: Path, selected_profiles: List[str]) -> Dict[str, Any]:
        """Migrates selected legacy profiles."""
        results = {
            'successful': [],
            'failed': [],
            'total_processed': 0,
            'user_data_copied': 0,
            'errors': []
        }
        
        legacy_profiles = self.scan_legacy_profiles(legacy_dir)
        
        for legacy_data in legacy_profiles:
            folder_name = legacy_data['folder_path'].name
            
            # Skip if not selected
            if folder_name not in selected_profiles:
                continue
                
            results['total_processed'] += 1
            
            try:
                new_profile, user_data_copied = self.convert_legacy_profile(legacy_data)
                
                results['successful'].append({
                    'legacy_name': folder_name,
                    'new_name': new_profile.name,
                    'new_id': new_profile.id,
                    'user_data_copied': user_data_copied
                })
                
                if user_data_copied:
                    results['user_data_copied'] += 1
                    
                self.logger.info(f"Successfully migrated profile: {folder_name} -> {new_profile.name}")
                
            except Exception as e:
                error_msg = f"Failed to migrate {folder_name}: {str(e)}"
                results['failed'].append(folder_name)
                results['errors'].append(error_msg)
                self.logger.error(error_msg)
                
        return results
        
    def _convert_proxy_settings(self, config: Dict[str, Any]) -> Optional[str]:
        """Converts legacy proxy settings to new format."""
        proxy_flag = config.get('proxy_flag', 0)
        
        if not proxy_flag:
            return None
            
        proxy_url = config.get('proxy_url', '').strip()
        proxy_port = config.get('proxy_port', '').strip()
        
        if not proxy_url or not proxy_port:
            return None
            
        # Try to determine protocol (default to http if not specified)
        if '://' not in proxy_url:
            # Check if it might be socks based on port or other indicators
            try:
                port_num = int(proxy_port)
                if port_num in [1080, 1081, 9050, 9150]:  # Common SOCKS ports
                    protocol = 'socks5'
                else:
                    protocol = 'http'
            except:
                protocol = 'http'
                
            proxy = f"{protocol}://{proxy_url}:{proxy_port}"
        else:
            proxy = f"{proxy_url}:{proxy_port}"
            
        return proxy
        
    def _create_migration_notes(self, config: Dict[str, Any]) -> str:
        """Creates notes with additional legacy profile information."""
        notes_parts = ["=== Migrated from legacy profile ==="]
        
        # Add migration timestamp
        notes_parts.append(f"Migrated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        # Add chromium version if available
        if 'chromium_version' in config:
            notes_parts.append(f"Original Chromium version: {config['chromium_version']}")
            
        # Add remote control port if available
        if 'rc_port' in config:
            notes_parts.append(f"Remote control port: {config['rc_port']}")
            
        # Add auth information if available
        if config.get('auth_flag'):
            notes_parts.append("Proxy authentication was enabled")
            if config.get('proxy_user'):
                notes_parts.append(f"Proxy user: {config['proxy_user']}")
                
        # Add any other interesting fields
        for key, value in config.items():
            if key not in ['name', 'user_agent', 'proxy_flag', 'proxy_url', 
                          'proxy_port', 'proxy_user', 'proxy_pass', 'chromium_version', 
                          'auth_flag', 'rc_port'] and value:
                notes_parts.append(f"{key}: {value}")
                
        return "\n".join(notes_parts)
        
    def _copy_user_data(self, source_dir: Path, dest_dir: Path) -> bool:
        """Copies user data from legacy profile to new location."""
        try:
            if not source_dir.exists():
                return False
                
            # Remove destination if it exists (should be empty from profile creation)
            if dest_dir.exists():
                shutil.rmtree(dest_dir)
                
            # Copy the entire user-data directory
            shutil.copytree(source_dir, dest_dir)
            
            self.logger.info(f"Copied user data: {source_dir} -> {dest_dir}")
            return True
            
        except Exception as e:
            self.logger.error(f"Error copying user data: {e}")
            return False
            
    def _calculate_folder_size(self, folder_path: Path) -> int:
        """Calculates total size of folder in bytes."""
        total_size = 0
        try:
            for file_path in folder_path.rglob('*'):
                if file_path.is_file():
                    total_size += file_path.stat().st_size
        except:
            pass
        return total_size
        
    def _sanitize_profile_name(self, name: str) -> str:
        """Sanitizes profile name to make it valid."""
        # Remove invalid characters
        import re
        sanitized = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name)
        
        # Remove dots and spaces at the end
        sanitized = sanitized.rstrip('. ')
        
        # Limit length
        if len(sanitized) > 80:
            sanitized = sanitized[:80]
            
        # Ensure not empty
        if not sanitized:
            sanitized = "Imported_Profile"
            
        return sanitized
        
    def format_file_size(self, size_bytes: int) -> str:
        """Formats file size in human-readable format."""
        if size_bytes == 0:
            return "0 B"
            
        size_names = ["B", "KB", "MB", "GB"]
        i = 0
        while size_bytes >= 1024.0 and i < len(size_names) - 1:
            size_bytes /= 1024.0
            i += 1
            
        return f"{size_bytes:.1f} {size_names[i]}"