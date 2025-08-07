"""Tests for ProfileManager."""

import pytest
import tempfile
import json
from pathlib import Path

from theprivator.core.profile_manager import ProfileManager, ChromiumProfile
from theprivator.utils.exceptions import ValidationError, ProfileError


class TestProfileManager:
    """Test class for ProfileManager."""
    
    def setup_method(self):
        """Setup for each test method."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_dir = Path(self.temp_dir.name)
        self.manager = ProfileManager(self.config_dir)
        
    def teardown_method(self):
        """Cleanup after each test method."""
        self.temp_dir.cleanup()
        
    def test_create_profile_success(self):
        """Test successful profile creation."""
        profile = self.manager.create_profile(
            name="Test Profile",
            user_agent="Mozilla/5.0 (Test) Chrome/100.0",
            proxy="http://proxy.com:8080"
        )
        
        assert profile.name == "Test Profile"
        assert profile.user_agent == "Mozilla/5.0 (Test) Chrome/100.0"
        assert profile.proxy == "http://proxy.com:8080"
        assert profile.id is not None
        assert profile.user_data_dir is not None
        
    def test_create_profile_invalid_name(self):
        """Test profile creation with invalid name."""
        with pytest.raises(ValidationError):
            self.manager.create_profile("", "Mozilla/5.0")
            
        with pytest.raises(ValidationError):
            self.manager.create_profile("test<>", "Mozilla/5.0")
            
    def test_create_profile_invalid_user_agent(self):
        """Test profile creation with invalid user agent."""
        with pytest.raises(ValidationError):
            self.manager.create_profile("Test", "invalid-user-agent")
            
    def test_create_profile_invalid_proxy(self):
        """Test profile creation with invalid proxy."""
        with pytest.raises(ValidationError):
            self.manager.create_profile("Test", "Mozilla/5.0", "invalid-proxy")
            
    def test_duplicate_profile_name(self):
        """Test creating profile with duplicate name."""
        self.manager.create_profile("Test", "Mozilla/5.0")
        
        with pytest.raises(ValidationError):
            self.manager.create_profile("Test", "Mozilla/5.0")
            
    def test_get_profile_by_name(self):
        """Test getting profile by name."""
        created = self.manager.create_profile("Test", "Mozilla/5.0")
        found = self.manager.get_profile_by_name("Test")
        
        assert found is not None
        assert found.id == created.id
        assert found.name == created.name
        
    def test_update_profile(self):
        """Test profile update."""
        profile = self.manager.create_profile("Test", "Mozilla/5.0")
        
        self.manager.update_profile(
            profile.id,
            name="Updated Test",
            proxy="http://new-proxy.com:8080"
        )
        
        updated = self.manager.get_profile(profile.id)
        assert updated.name == "Updated Test"
        assert updated.proxy == "http://new-proxy.com:8080"
        
    def test_delete_profile(self):
        """Test profile deletion."""
        profile = self.manager.create_profile("Test", "Mozilla/5.0")
        profile_id = profile.id
        
        self.manager.delete_profile(profile_id)
        
        assert self.manager.get_profile(profile_id) is None
        
    def test_export_import_profile(self):
        """Test profile export and import."""
        # Create and export profile
        original = self.manager.create_profile(
            "Export Test", 
            "Mozilla/5.0",
            "http://proxy.com:8080"
        )
        
        export_path = self.config_dir / "test_export.json"
        self.manager.export_profile(original.id, export_path)
        
        assert export_path.exists()
        
        # Import profile
        imported = self.manager.import_profile(export_path)
        
        assert imported.name == "Export Test"
        assert imported.user_agent == "Mozilla/5.0"
        assert imported.proxy == "http://proxy.com:8080"
        assert imported.id != original.id  # Should have new ID
        
    def test_get_stats(self):
        """Test getting profile statistics."""
        stats = self.manager.get_stats()
        assert stats['total_profiles'] == 0
        
        self.manager.create_profile("Test1", "Mozilla/5.0")
        self.manager.create_profile("Test2", "Mozilla/5.0")
        
        stats = self.manager.get_stats()
        assert stats['total_profiles'] == 2
        
    def test_persistence(self):
        """Test that profiles persist between manager instances."""
        # Create profile with first manager
        profile = self.manager.create_profile("Persistent", "Mozilla/5.0")
        
        # Create new manager instance
        new_manager = ProfileManager(self.config_dir)
        
        # Check if profile exists
        found = new_manager.get_profile(profile.id)
        assert found is not None
        assert found.name == "Persistent"


class TestChromiumProfile:
    """Test class for ChromiumProfile."""
    
    def test_profile_creation(self):
        """Test profile creation and properties."""
        profile = ChromiumProfile(
            id="test-id",
            name="Test Profile",
            user_agent="Mozilla/5.0",
            proxy="http://proxy.com:8080"
        )
        
        assert profile.id == "test-id"
        assert profile.name == "Test Profile"
        assert profile.display_name == "⚫ Test Profile"
        
    def test_profile_serialization(self):
        """Test profile to/from dict conversion."""
        profile = ChromiumProfile(
            id="test-id",
            name="Test",
            user_agent="Mozilla/5.0"
        )
        
        data = profile.to_dict()
        assert isinstance(data, dict)
        assert data['name'] == "Test"
        
        restored = ChromiumProfile.from_dict(data)
        assert restored.name == profile.name
        assert restored.id == profile.id