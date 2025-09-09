#!/usr/bin/env python3
"""
thePrivator API Server
REST API for programmatic interaction with thePrivator.
"""

import sys
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any
from datetime import datetime
import asyncio
import uvicorn
from fastapi import FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
import json

# Add src to Python path
src_dir = Path(__file__).parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from core.profile_manager import ProfileManager, ChromiumProfile
from core.chromium_launcher import ChromiumLauncher
from core.config_manager import ConfigManager
from utils.logger import get_logger, setup_logger
from utils.exceptions import ProfileError, LaunchError, ValidationError


# Pydantic Models for API requests/responses
class ProfileCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, description="Profile name")
    user_agent: str = Field(..., min_length=1, description="User agent string")
    proxy: Optional[str] = Field(None, description="Proxy server (format: protocol://host:port)")
    notes: str = Field("", description="Profile notes")


class ProfileUpdateRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100, description="Profile name")
    user_agent: Optional[str] = Field(None, min_length=1, description="User agent string")
    proxy: Optional[str] = Field(None, description="Proxy server (format: protocol://host:port)")
    notes: Optional[str] = Field(None, description="Profile notes")


class ProfileLaunchRequest(BaseModel):
    headless: bool = Field(False, description="Launch in headless mode")
    incognito: bool = Field(False, description="Launch in incognito mode")
    additional_args: List[str] = Field([], description="Additional Chromium arguments")


class ProfileResponse(BaseModel):
    id: str
    name: str
    user_agent: str
    proxy: Optional[str]
    user_data_dir: Optional[str]
    created_at: str
    last_used: str
    is_active: bool
    notes: str


class ProcessResponse(BaseModel):
    pid: int
    profile_id: str
    profile_name: str
    started_at: str
    uptime: str


class StatsResponse(BaseModel):
    total_profiles: int
    active_profiles: int
    inactive_profiles: int
    running_processes: int
    last_created: Optional[str]


class ErrorResponse(BaseModel):
    error: str
    detail: Optional[str] = None
    timestamp: str = Field(default_factory=lambda: datetime.now().isoformat())


class APIServer:
    """thePrivator REST API Server."""
    
    def __init__(self, port: int = 8080, config_dir: Optional[Path] = None):
        self.port = port
        self.config_dir = config_dir or Path.home() / ".theprivator"
        self.config_dir.mkdir(exist_ok=True)
        
        # Setup logging
        self.logger = setup_logger(self.config_dir / "logs")
        
        # Initialize managers
        self.config_manager = ConfigManager(config_dir=self.config_dir)
        self.profile_manager = ProfileManager(config_dir=self.config_dir, config_manager=self.config_manager)
        self.launcher = ChromiumLauncher(config_manager=self.config_manager)
        
        # Create FastAPI app
        self.app = self._create_app()
        
    def _create_app(self) -> FastAPI:
        """Creates FastAPI application."""
        app = FastAPI(
            title="thePrivator API",
            description="REST API for thePrivator - Chromium Profile Manager",
            version="1.0.0",
            docs_url="/docs",
            redoc_url="/redoc",
        )
        
        # Add CORS middleware
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
        
        # Exception handlers
        @app.exception_handler(ProfileError)
        async def profile_error_handler(request, exc):
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(error="ProfileError", detail=str(exc)).dict()
            )
        
        @app.exception_handler(LaunchError)
        async def launch_error_handler(request, exc):
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(error="LaunchError", detail=str(exc)).dict()
            )
        
        @app.exception_handler(ValidationError)
        async def validation_error_handler(request, exc):
            return JSONResponse(
                status_code=422,
                content=ErrorResponse(error="ValidationError", detail=str(exc)).dict()
            )
        
        # Routes
        self._add_routes(app)
        
        return app
    
    def _add_routes(self, app: FastAPI):
        """Add API routes."""
        
        # Health check
        @app.get("/health", tags=["System"])
        async def health_check():
            """Health check endpoint."""
            return {"status": "healthy", "timestamp": datetime.now().isoformat()}
        
        # System info
        @app.get("/system/info", tags=["System"])
        async def get_system_info():
            """Get system information."""
            return {
                "name": "thePrivator API",
                "version": "1.0.0",
                "chromium_path": self.launcher._chromium_path,
                "config_dir": str(self.config_dir),
                "has_psutil": hasattr(self.launcher, 'HAS_PSUTIL') and self.launcher.HAS_PSUTIL if hasattr(self.launcher, 'HAS_PSUTIL') else True
            }
        
        # Statistics
        @app.get("/stats", response_model=StatsResponse, tags=["System"])
        async def get_stats():
            """Get system statistics."""
            stats = self.profile_manager.get_stats()
            running_processes = len(self.launcher.get_running_profiles())
            
            return StatsResponse(
                total_profiles=stats['total_profiles'],
                active_profiles=stats['active_profiles'],
                inactive_profiles=stats['inactive_profiles'],
                running_processes=running_processes,
                last_created=stats.get('last_created')
            )
        
        # Profile management
        @app.get("/profiles", response_model=List[ProfileResponse], tags=["Profiles"])
        async def list_profiles():
            """List all profiles."""
            profiles = self.profile_manager.get_all_profiles()
            return [ProfileResponse(**profile.to_dict()) for profile in profiles]
        
        @app.post("/profiles", response_model=ProfileResponse, status_code=status.HTTP_201_CREATED, tags=["Profiles"])
        async def create_profile(request: ProfileCreateRequest):
            """Create a new profile."""
            profile = self.profile_manager.create_profile(
                name=request.name,
                user_agent=request.user_agent,
                proxy=request.proxy,
                notes=request.notes
            )
            return ProfileResponse(**profile.to_dict())
        
        @app.get("/profiles/{profile_id}", response_model=ProfileResponse, tags=["Profiles"])
        async def get_profile(profile_id: str):
            """Get profile by ID."""
            profile = self.profile_manager.get_profile(profile_id)
            if not profile:
                raise HTTPException(status_code=404, detail="Profile not found")
            return ProfileResponse(**profile.to_dict())
        
        @app.put("/profiles/{profile_id}", response_model=ProfileResponse, tags=["Profiles"])
        async def update_profile(profile_id: str, request: ProfileUpdateRequest):
            """Update profile."""
            profile = self.profile_manager.get_profile(profile_id)
            if not profile:
                raise HTTPException(status_code=404, detail="Profile not found")
            
            update_data = request.dict(exclude_unset=True)
            self.profile_manager.update_profile(profile_id, **update_data)
            
            updated_profile = self.profile_manager.get_profile(profile_id)
            return ProfileResponse(**updated_profile.to_dict())
        
        @app.delete("/profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Profiles"])
        async def delete_profile(profile_id: str):
            """Delete profile."""
            profile = self.profile_manager.get_profile(profile_id)
            if not profile:
                raise HTTPException(status_code=404, detail="Profile not found")
            
            # Terminate if running
            if self.launcher.is_profile_running(profile_id):
                self.launcher.terminate_profile(profile_id)
            
            self.profile_manager.delete_profile(profile_id)
        
        # Profile launching and management
        @app.post("/profiles/{profile_id}/launch", response_model=ProcessResponse, tags=["Launcher"])
        async def launch_profile(profile_id: str, request: ProfileLaunchRequest = ProfileLaunchRequest()):
            """Launch profile."""
            profile = self.profile_manager.get_profile(profile_id)
            if not profile:
                raise HTTPException(status_code=404, detail="Profile not found")
            
            process = self.launcher.launch_profile(
                profile=profile,
                additional_args=request.additional_args,
                headless=request.headless,
                incognito=request.incognito
            )
            
            # Mark profile as used
            self.profile_manager.mark_as_used(profile_id)
            self.profile_manager.set_active_status(profile_id, True)
            
            return ProcessResponse(
                pid=process.pid,
                profile_id=process.profile_id,
                profile_name=process.profile_name,
                started_at=process.started_at,
                uptime=process.uptime
            )
        
        @app.post("/profiles/{profile_id}/terminate", status_code=status.HTTP_204_NO_CONTENT, tags=["Launcher"])
        async def terminate_profile(profile_id: str, force: bool = Query(False, description="Force termination")):
            """Terminate profile process."""
            if not self.launcher.is_profile_running(profile_id):
                raise HTTPException(status_code=404, detail="Profile process not found")
            
            success = self.launcher.terminate_profile(profile_id, force=force)
            if not success:
                raise HTTPException(status_code=500, detail="Failed to terminate process")
            
            # Mark profile as inactive
            self.profile_manager.set_active_status(profile_id, False)
        
        @app.get("/profiles/{profile_id}/process", response_model=ProcessResponse, tags=["Launcher"])
        async def get_profile_process(profile_id: str):
            """Get profile process information."""
            process = self.launcher.get_profile_process(profile_id)
            if not process:
                raise HTTPException(status_code=404, detail="Profile process not found")
            
            return ProcessResponse(
                pid=process.pid,
                profile_id=process.profile_id,
                profile_name=process.profile_name,
                started_at=process.started_at,
                uptime=process.uptime
            )
        
        @app.get("/profiles/{profile_id}/process/stats", tags=["Launcher"])
        async def get_profile_process_stats(profile_id: str):
            """Get profile process statistics."""
            stats = self.launcher.get_process_stats(profile_id)
            if not stats:
                raise HTTPException(status_code=404, detail="Profile process not found")
            
            return stats
        
        # Process management
        @app.get("/processes", response_model=List[ProcessResponse], tags=["Launcher"])
        async def list_running_processes():
            """List all running profile processes."""
            processes = self.launcher.get_running_profiles()
            return [
                ProcessResponse(
                    pid=proc.pid,
                    profile_id=proc.profile_id,
                    profile_name=proc.profile_name,
                    started_at=proc.started_at,
                    uptime=proc.uptime
                ) for proc in processes
            ]
        
        @app.post("/processes/terminate-all", tags=["Launcher"])
        async def terminate_all_processes(force: bool = Query(False, description="Force termination")):
            """Terminate all running profile processes."""
            count = 0
            running_processes = self.launcher.get_running_profiles()
            
            for process in running_processes:
                success = self.launcher.terminate_profile(process.profile_id, force=force)
                if success:
                    count += 1
                    # Mark profile as inactive
                    self.profile_manager.set_active_status(process.profile_id, False)
            
            return {"terminated_count": count, "total_processes": len(running_processes)}
        
        @app.post("/processes/cleanup", tags=["Launcher"])
        async def cleanup_orphaned_processes():
            """Clean up orphaned processes."""
            cleaned = self.launcher.cleanup_orphaned_processes()
            return {"cleaned_count": cleaned}
        
        # Profile import/export
        @app.get("/profiles/{profile_id}/export", tags=["Import/Export"])
        async def export_profile(profile_id: str):
            """Export profile data."""
            profile = self.profile_manager.get_profile(profile_id)
            if not profile:
                raise HTTPException(status_code=404, detail="Profile not found")
            
            export_data = {
                'version': '2.0',
                'profile': profile.to_dict(),
                'exported_at': datetime.now().isoformat()
            }
            
            return export_data
        
        @app.post("/profiles/import", response_model=ProfileResponse, tags=["Import/Export"])
        async def import_profile(profile_data: dict):
            """Import profile from data."""
            if 'profile' not in profile_data:
                raise HTTPException(status_code=400, detail="Invalid profile data format")
            
            profile_dict = profile_data['profile']
            
            # Create profile through manager (it will handle validation and ID generation)
            profile = self.profile_manager.create_profile(
                name=profile_dict.get('name', 'Imported Profile'),
                user_agent=profile_dict.get('user_agent', ''),
                proxy=profile_dict.get('proxy'),
                notes=profile_dict.get('notes', 'Imported via API')
            )
            
            return ProfileResponse(**profile.to_dict())
        
        # Configuration
        @app.get("/config", tags=["Configuration"])
        async def get_config():
            """Get configuration."""
            return {
                "custom_chromium_path": self.config_manager.get('custom_chromium_path', ''),
                "custom_data_directory": self.config_manager.get('custom_data_directory', ''),
            }
        
        @app.put("/config", tags=["Configuration"])
        async def update_config(config_data: dict):
            """Update configuration."""
            for key, value in config_data.items():
                if key in ['custom_chromium_path', 'custom_data_directory']:
                    self.config_manager.set(key, value)
            
            return {"status": "success", "message": "Configuration updated"}
    
    async def start_server(self):
        """Start the API server."""
        self.logger.info(f"Starting thePrivator API server on port {self.port}")
        
        config = uvicorn.Config(
            app=self.app,
            host="127.0.0.1",
            port=self.port,
            log_level="info"
        )
        
        server = uvicorn.Server(config)
        await server.serve()


def run_api_server(port: int = 8080, config_dir: Optional[Path] = None):
    """Run the API server."""
    server = APIServer(port=port, config_dir=config_dir)
    asyncio.run(server.start_server())


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="thePrivator API Server")
    parser.add_argument("--port", type=int, default=8080, help="API server port")
    parser.add_argument("--config-dir", type=Path, help="Configuration directory")
    
    args = parser.parse_args()
    
    run_api_server(port=args.port, config_dir=args.config_dir)