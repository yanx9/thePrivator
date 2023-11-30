from typing import Optional, Tuple, Union
import customtkinter as ctk
from ..Model.Profile import Profile

class Config(ctk.CTk):
    def __init__(self, profile:Profile):
        self.title(f"Configuration: {profile.name}")
        self.geometry(f"{600}x{500}")
        
        super().__init__()
