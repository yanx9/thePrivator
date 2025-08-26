"""Chromium profile manager with better error handling and validation."""

import json
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
from datetime import datetime
import sys

# Add src to path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from utils.logger import get_logger
from utils.validator import validate_proxy, validate_user_agent, validate_profile_name
from utils.exceptions import ProfileError, ValidationError


@dataclass
class ChromiumProfile:
    """Represents a Chromium profile."""
    
    id: str
    name: str
    user_agent: str
    proxy: Optional[str] = None
    user_data_dir: Optional[str] = None
    created_at: str = ""
    last_used: str = ""
    is_active: bool = False
    notes: str = ""
    
    def __post_init__(self):
        if not self.id:
            self.id = str(uuid.uuid4())
        if not self.created_at:
            self.created_at = datetime.now().isoformat()
            
    def to_dict(self) -> Dict[str, Any]:
        """Converts profile to dictionary."""
        return asdict(self)
        
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'ChromiumProfile':
        """Creates profile from dictionary."""
        if 'notes' not in data:
            data['notes'] = ""
        return cls(**data)
    
    @property
    def display_name(self) -> str:
        """Returns display name of profile."""
        status = "🟢" if self.is_active else "⚫"
        return f"{status} {self.name}"


class ProfileManager:
    """Manages Chromium profiles."""
    
    def __init__(self, config_dir: Optional[Path] = None):
        self.logger = get_logger(__name__)
        self.config_dir = config_dir or Path.home() / ".theprivator"
        self.config_dir.mkdir(exist_ok=True)
        self.profiles_file = self.config_dir / "profiles.json"
        self.profiles_dir = self.config_dir / "profiles"
        self.profiles_dir.mkdir(exist_ok=True)
        self._profiles: Dict[str, ChromiumProfile] = {}
        self._load_profiles()
        
    def create_profile(self, name: str, user_agent: str, proxy: Optional[str] = None, notes: str = "") -> ChromiumProfile:
        """Creates a new profile."""
        try:
            # Data validation
            if not validate_profile_name(name):
                raise ValidationError("Invalid profile name")
                
            if self.get_profile_by_name(name):
                raise ValidationError(f"Profile with name '{name}' already exists")
                
            if not validate_user_agent(user_agent):
                raise ValidationError("Invalid User-Agent")
                
            if proxy and not validate_proxy(proxy):
                raise ValidationError("Invalid proxy format")
                
            # Create profile
            profile = ChromiumProfile(
                id=str(uuid.uuid4()),
                name=name.strip(),
                user_agent=user_agent.strip(),
                proxy=proxy.strip() if proxy else None,
                notes=notes.strip()
            )
            
            # Create user data directory
            user_data_dir = self.profiles_dir / profile.id
            user_data_dir.mkdir(parents=True, exist_ok=True)
            profile.user_data_dir = str(user_data_dir)
            
            self._profiles[profile.id] = profile
            self._save_profiles()
            
            self.logger.info(f"Created profile: {name} (ID: {profile.id})")
            return profile
            
        except Exception as e:
            raise ProfileError(f"Error creating profile: {e}")
            
    def get_profile(self, profile_id: str) -> Optional[ChromiumProfile]:
        """Gets profile by ID."""
        return self._profiles.get(profile_id)
        
    def get_profile_by_name(self, name: str) -> Optional[ChromiumProfile]:
        """Gets profile by name."""
        for profile in self._profiles.values():
            if profile.name.lower() == name.lower():
                return profile
        return None
        
    def get_all_profiles(self) -> List[ChromiumProfile]:
        """Gets all profiles sorted alphabetically by name."""
        return sorted(self._profiles.values(), 
                    key=lambda p: p.name.lower())  # Sort by name alphabetically
        
    def update_profile(self, profile_id: str, **kwargs) -> None:
        """Updates profile."""
        profile = self.get_profile(profile_id)
        if not profile:
            raise ProfileError(f"Profile {profile_id} does not exist")
            
        # Validate updated fields
        if 'name' in kwargs and kwargs['name'] != profile.name:
            if not validate_profile_name(kwargs['name']):
                raise ValidationError("Invalid profile name")
            if self.get_profile_by_name(kwargs['name']):
                raise ValidationError(f"Profile with name '{kwargs['name']}' already exists")
                
        if 'user_agent' in kwargs and not validate_user_agent(kwargs['user_agent']):
            raise ValidationError("Invalid User-Agent")
            
        if 'proxy' in kwargs and kwargs['proxy'] and not validate_proxy(kwargs['proxy']):
            raise ValidationError("Invalid proxy format")
            
        # Update fields
        for key, value in kwargs.items():
            if hasattr(profile, key):
                setattr(profile, key, value)
                
        self._save_profiles()
        self.logger.info(f"Updated profile: {profile.name}")
        
    def delete_profile(self, profile_id: str) -> None:
        """Deletes profile."""
        profile = self.get_profile(profile_id)
        if not profile:
            raise ProfileError(f"Profile {profile_id} does not exist")
            
        # Remove data directory
        if profile.user_data_dir:
            user_data_path = Path(profile.user_data_dir)
            if user_data_path.exists():
                import shutil
                try:
                    shutil.rmtree(user_data_path)
                    self.logger.info(f"Removed data directory: {user_data_path}")
                except Exception as e:
                    self.logger.warning(f"Cannot remove data directory: {e}")
                
        del self._profiles[profile_id]
        self._save_profiles()
        
        self.logger.info(f"Deleted profile: {profile.name}")
        
    def mark_as_used(self, profile_id: str) -> None:
        """Marks profile as recently used."""
        profile = self.get_profile(profile_id)
        if profile:
            profile.last_used = datetime.now().isoformat()
            self._save_profiles()
            
    def set_active_status(self, profile_id: str, is_active: bool) -> None:
        """Sets profile activity status."""
        profile = self.get_profile(profile_id)
        if profile:
            profile.is_active = is_active
            self._save_profiles()
            
    def export_profile(self, profile_id: str, export_path: Path) -> None:
        """Exports profile to file."""
        profile = self.get_profile(profile_id)
        if not profile:
            raise ProfileError(f"Profile {profile_id} does not exist")
            
        export_data = {
            'version': '2.0',
            'profile': profile.to_dict(),
            'exported_at': datetime.now().isoformat()
        }
        
        with open(export_path, 'w', encoding='utf-8') as f:
            json.dump(export_data, f, indent=2, ensure_ascii=False)
            
        self.logger.info(f"Exported profile to: {export_path}")
        
    def import_profile(self, import_path: Path) -> ChromiumProfile:
        """Imports profile from file."""
        try:
            with open(import_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                
            if 'profile' not in data:
                raise ValidationError("Invalid file format")
                
            profile_data = data['profile']
            
            # Generate new ID to avoid conflicts
            profile_data['id'] = str(uuid.uuid4())
            
            # Check if name already exists
            original_name = profile_data['name']
            counter = 1
            while self.get_profile_by_name(profile_data['name']):
                profile_data['name'] = f"{original_name} ({counter})"
                counter += 1
                
            profile = ChromiumProfile.from_dict(profile_data)
            
            # Create data directory
            user_data_dir = self.profiles_dir / profile.id
            user_data_dir.mkdir(parents=True, exist_ok=True)
            profile.user_data_dir = str(user_data_dir)
            
            self._profiles[profile.id] = profile
            self._save_profiles()
            
            self.logger.info(f"Imported profile: {profile.name}")
            return profile
            
        except Exception as e:
            raise ProfileError(f"Error importing profile: {e}")
            
    def get_stats(self) -> Dict[str, Any]:
        """Returns profile statistics."""
        profiles = self.get_all_profiles()
        active_count = sum(1 for p in profiles if p.is_active)
        
        return {
            'total_profiles': len(profiles),
            'active_profiles': active_count,
            'inactive_profiles': len(profiles) - active_count,
            'last_created': profiles[0].created_at if profiles else None,
            'total_size': self._calculate_total_size()
        }
        
    def _calculate_total_size(self) -> int:
        """Calculates total size of profile directories."""
        total_size = 0
        for profile in self._profiles.values():
            if profile.user_data_dir:
                profile_path = Path(profile.user_data_dir)
                if profile_path.exists():
                    try:
                        total_size += sum(f.stat().st_size for f in profile_path.rglob('*') if f.is_file())
                    except:
                        pass
        return total_size
        
    def _load_profiles(self) -> None:
        """Loads profiles from file."""
        try:
            if self.profiles_file.exists():
                with open(self.profiles_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    for profile_data in data.get('profiles', []):
                        try:
                            profile = ChromiumProfile.from_dict(profile_data)
                            self._profiles[profile.id] = profile
                        except Exception as e:
                            self.logger.warning(f"Skipped invalid profile: {e}")
                self.logger.info(f"Loaded {len(self._profiles)} profiles")
        except Exception as e:
            self.logger.error(f"Error loading profiles: {e}")
            # Create backup of corrupted file
            if self.profiles_file.exists():
                backup_file = self.profiles_file.with_suffix('.json.backup')
                self.profiles_file.rename(backup_file)
                self.logger.info(f"Created backup of corrupted file: {backup_file}")
            
    def _save_profiles(self) -> None:
        """Saves profiles to file."""
        try:
            data = {
                'version': '2.0',
                'created_at': datetime.now().isoformat(),
                'profiles': [profile.to_dict() for profile in self._profiles.values()]
            }
            
            # Atomic save
            temp_file = self.profiles_file.with_suffix('.tmp')
            with open(temp_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            temp_file.replace(self.profiles_file)
            
        except Exception as e:
            self.logger.error(f"Error saving profiles: {e}")
            raise ProfileError(f"Cannot save profiles: {e}")