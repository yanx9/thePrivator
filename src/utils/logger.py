"""Logging system for thePrivator."""

import logging
import sys
from pathlib import Path
from typing import Optional
from logging.handlers import RotatingFileHandler


def setup_logger(log_dir: Optional[Path] = None) -> logging.Logger:
    """Configures the main application logger."""
    logger = logging.getLogger('theprivator')
    
    if logger.handlers:
        return logger
        
    logger.setLevel(logging.INFO)
    
    # Log format
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    
    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)
    
    # File handler with rotation (if directory provided)
    if log_dir:
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
            
            file_handler = RotatingFileHandler(
                log_dir / "theprivator.log",
                maxBytes=10*1024*1024,  # 10MB
                backupCount=5,
                encoding='utf-8'
            )
            file_handler.setLevel(logging.DEBUG)
            file_handler.setFormatter(formatter)
            logger.addHandler(file_handler)
        except Exception as e:
            print(f"Cannot create log file: {e}")
    
    logger.info("Logger configured")
    return logger


def get_logger(name: str) -> logging.Logger:
    """Gets a logger for a module."""
    return logging.getLogger(f'theprivator.{name}')


def cleanup_old_logs(log_dir: Path, days: int = 30) -> None:
    """Removes old log files."""
    try:
        import time
        cutoff_time = time.time() - (days * 24 * 60 * 60)
        
        for log_file in log_dir.glob("*.log*"):
            if log_file.stat().st_mtime < cutoff_time:
                log_file.unlink()
                print(f"Removed old log: {log_file}")
                
    except Exception as e:
        print(f"Error cleaning up logs: {e}")