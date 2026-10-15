import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

w = np.linspace(-2, 2, 28)
b = np.linspace(-2, 2, 28)
W, B = np.meshgrid(w, b)
Z = np.logaddexp(0, -W) + 0.1 * (W ** 2 + B ** 2)
fig = plt.figure(figsize=(3.2, 2.6))
ax = fig.add_subplot(111, projection="3d")
ax.plot_surface(W, B, Z, color="#d7c4a3", linewidth=0, antialiased=False)
ax.set_xlabel("w")
ax.set_ylabel("b")
ax.set_zlabel("loss")
fig.savefig("figure.png", dpi=60)
