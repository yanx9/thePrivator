import customtkinter as ctk
from core import Core
class Config(ctk.CTkToplevel):
    def __init__(self, *args, **kwargs):
        self.core = Core()
        self.geometry("440x200")