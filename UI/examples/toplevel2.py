import tkinter as tk

def open_toplevel():
    # Create a new Toplevel window
    toplevel = tk.Toplevel(root)
    
    # Add widgets to the Toplevel window
    label = tk.Label(toplevel, text="This is a Toplevel window")
    label.pack(padx=10, pady=10)
    
    # Button to close the Toplevel window
    close_button = tk.Button(toplevel, text="Close", command=toplevel.destroy)
    close_button.pack(pady=10)

    # Bind the function to be called when the Toplevel window is destroyed
    toplevel.protocol("WM_DELETE_WINDOW", on_toplevel_close)

def on_toplevel_close():
    print("Toplevel window is closed, performing additional actions")

# Create the main window
root = tk.Tk()
root.title("Main Window")

# Button to open the Toplevel window
open_button = tk.Button(root, text="Open Toplevel", command=open_toplevel)
open_button.pack(pady=20)

# Run the Tkinter event loop
root.mainloop()
