"""Profile import/export utilities for main window integration."""

import json
import hashlib
from pathlib import Path
from typing import List, Dict, Any, Optional
from datetime import datetime
import tkinter.filedialog as filedialog
import tkinter.messagebox as msgbox

from utils.logger import get_logger
from utils.exceptions import ProfileError


class ProfileIOManager:
    """Manages profile import/export operations for the main window."""
    
    def __init__(self, profile_manager, chromium_launcher):
        self.profile_manager = profile_manager
        self.chromium_launcher = chromium_launcher
        self.logger = get_logger(__name__)
    
    def export_selected_profiles(self, selected_profile_ids: List[str], parent_window=None) -> Optional[Dict[str, Any]]:
        """Export selected profiles with file dialog.
        
        Args:
            selected_profile_ids: List of profile IDs to export
            parent_window: Parent window for dialogs
            
        Returns:
            Export results dictionary or None if cancelled
        """
        if not selected_profile_ids:
            msgbox.showwarning("No Selection", "Please select at least one profile to export")
            return None
        
        # Check for running profiles
        running_profiles = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
        selected_running = [pid for pid in selected_profile_ids if pid in running_profiles]
        
        if selected_running:
            running_names = []
            for pid in selected_running:
                profile = self.profile_manager.get_profile(pid)
                if profile:
                    running_names.append(profile.name)
            
            if not msgbox.askyesno(
                "Running Profiles",
                f"Some selected profiles are running:\\n{', '.join(running_names)}\\n\\nExport anyway?"
            ):
                return None
        
        # Generate filename
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        if len(selected_profile_ids) == 1:
            profile = self.profile_manager.get_profile(selected_profile_ids[0])
            safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in profile.name) if profile else "profile"
            default_filename = f"{safe_name}_{timestamp}.privator"
        else:
            default_filename = f"profiles_{len(selected_profile_ids)}_{timestamp}.privator"
        
        # Show save dialog
        file_path = filedialog.asksaveasfilename(
            parent=parent_window,
            title="Export profiles",
            defaultextension=".privator",
            filetypes=[("Privator Archive", "*.privator"), ("All files", "*.*")],
            initialfile=default_filename
        )
        
        if not file_path:
            return None
        
        try:
            # Export profiles
            self.profile_manager.export_profiles_bulk(selected_profile_ids, Path(file_path))
            
            # Calculate checksums for validation
            checksums = {}
            for profile_id in selected_profile_ids:
                profile = self.profile_manager.get_profile(profile_id)
                if profile:
                    checksums[profile_id] = self._calculate_profile_checksum(profile)
            
            result = {
                'file_path': file_path,
                'profile_count': len(selected_profile_ids),
                'checksums': checksums,
                'exported_profiles': selected_profile_ids
            }
            
            msgbox.showinfo(
                "Export Successful",
                f"Successfully exported {len(selected_profile_ids)} profile(s) to:\\n{file_path}"
            )
            
            self.logger.info(f"Exported {len(selected_profile_ids)} profiles to {file_path}")
            return result
            
        except Exception as e:
            self.logger.error(f"Export failed: {e}")
            msgbox.showerror("Export Error", f"Failed to export profiles:\\n{e}")
            return None
    
    def import_profiles(self, parent_window=None) -> Optional[Dict[str, Any]]:
        """Import profiles with file dialog.
        
        Args:
            parent_window: Parent window for dialogs
            
        Returns:
            Import results dictionary or None if cancelled
        """
        file_path = filedialog.askopenfilename(
            parent=parent_window,
            title="Import profiles",
            filetypes=[
                ("Privator Archive", "*.privator"),
                ("JSON files", "*.json"),
                ("All files", "*.*")
            ]
        )
        
        if not file_path:
            return None
        
        try:
            file_path = Path(file_path)
            
            if file_path.suffix.lower() == '.privator':
                # Bulk import from archive
                profiles = self.profile_manager.import_profiles_bulk(file_path)
                
                # Calculate checksums for validation
                checksums = {}
                for profile in profiles:
                    checksums[profile.id] = self._calculate_profile_checksum(profile)
                
                result = {
                    'file_path': str(file_path),
                    'profile_count': len(profiles),
                    'checksums': checksums,
                    'imported_profiles': [p.id for p in profiles]
                }
                
                msgbox.showinfo(
                    "Import Successful",
                    f"Successfully imported {len(profiles)} profile(s)"
                )
                
            else:
                # Single profile import
                profile = self.profile_manager.import_profile(file_path)
                checksum = self._calculate_profile_checksum(profile)
                
                result = {
                    'file_path': str(file_path),
                    'profile_count': 1,
                    'checksums': {profile.id: checksum},
                    'imported_profiles': [profile.id]
                }
                
                msgbox.showinfo(
                    "Import Successful",
                    f"Successfully imported profile: {profile.name}"
                )
            
            self.logger.info(f"Imported {result['profile_count']} profile(s) from {file_path}")
            return result
            
        except Exception as e:
            self.logger.error(f"Import failed: {e}")
            msgbox.showerror("Import Error", f"Failed to import profiles:\\n{e}")
            return None
    
    def _calculate_profile_checksum(self, profile) -> str:
        """Calculate a checksum for profile validation.
        
        Args:
            profile: ChromiumProfile instance
            
        Returns:
            SHA256 checksum of profile data
        """
        # Create a dictionary with profile data for hashing
        profile_data = {
            'name': profile.name,
            'user_agent': profile.user_agent,
            'proxy': profile.proxy or '',
            'notes': getattr(profile, 'notes', '') or ''
        }
        
        # Convert to JSON string for consistent hashing
        data_string = json.dumps(profile_data, sort_keys=True, ensure_ascii=False)
        
        # Calculate SHA256 hash
        return hashlib.sha256(data_string.encode('utf-8')).hexdigest()
    
    def validate_profile_checksums(self, profile_ids: List[str], expected_checksums: Dict[str, str]) -> Dict[str, bool]:
        """Validate profile checksums against expected values.
        
        Args:
            profile_ids: List of profile IDs to validate
            expected_checksums: Dictionary of profile_id -> expected_checksum
            
        Returns:
            Dictionary of profile_id -> validation_result (True/False)
        """
        results = {}
        
        for profile_id in profile_ids:
            profile = self.profile_manager.get_profile(profile_id)
            if profile and profile_id in expected_checksums:
                current_checksum = self._calculate_profile_checksum(profile)
                expected_checksum = expected_checksums[profile_id]
                results[profile_id] = (current_checksum == expected_checksum)
                
                if results[profile_id]:
                    self.logger.debug(f"Checksum validation PASSED for profile {profile.name}")
                else:
                    self.logger.warning(f"Checksum validation FAILED for profile {profile.name}")
            else:
                results[profile_id] = False
                self.logger.error(f"Profile {profile_id} not found for validation")
        
        return results