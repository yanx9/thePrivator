import tkinter as tk
import customtkinter

# Tworzenie głównego okna
root = tk.Tk()
root.title("Zarządzanie profilami Chromium")
root.geometry("800x600")

# Inicjalizacja CustomTkinter
custom_tk = customtkinter

# Górny pasek z przyciskami
top_frame = custom_tk.create_frame()
search_entry = custom_tk.create_entry(top_frame, placeholder="Wyszukaj profil")
add_button = custom_tk.create_button(top_frame, text="Dodaj Profil")
settings_button = custom_tk.create_button(top_frame, text="Ustawienia")

# Przewijalna lista profili
profile_listbox = custom_tk.create_listbox()
profile_listbox.place(x=20, y=50, width=760, height=400)

# Funkcja do aktualizacji listy profili
def update_profile_list():
    # Wczytywanie profili i aktualizacja listy
    profile_listbox.delete(0, "end")
    # Tutaj dodaj kod do wczytywania profili i dodawania ich do listy

# Wyświetlanie informacji o profilach
def display_profile_info():
    selected_profile = profile_listbox.get("active")
    if selected_profile:
        pass # NOTE
        # Tutaj dodaj kod do wyświetlania informacji o wybranym profilu

# Przyciski do zarządzania profilami
start_stop_button = custom_tk.create_button(text="Uruchom", command=display_profile_info)
configure_button = custom_tk.create_button(text="Konfiguracja", command=display_profile_info)

# Umieszczanie przycisków na ekranie
start_stop_button.place(x=100, y=470, width=100, height=30)
configure_button.place(x=220, y=470, width=150, height=30)

# Aktualizacja listy przy starcie aplikacji
update_profile_list()

# Uruchomienie głównej pętli
root.mainloop()
